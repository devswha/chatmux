import { chmod, writeFile } from 'node:fs/promises';

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function writeFakeAgent(executablePath: string): Promise<void> {
  await writeFile(executablePath, `#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agentName = path.basename(process.argv[1]);
const firstArgument = process.argv[2];
if (firstArgument === '--list-models' || (firstArgument === 'models' && process.argv.includes('--verbose')) || (firstArgument === 'models' && process.argv.includes('--json'))) {
  if (agentName === 'omp' && firstArgument === 'models') process.stdout.write('{"models":[]}\\n');
  else if (agentName === 'omo' && firstArgument === '--list-models') process.stdout.write('Name  Provider  Model  Thinking\\n');
  else if (agentName === 'cursor-agent' && firstArgument === '--list-models') process.stdout.write('Available models\\n');
  process.exit(0);
}
const logPath = firstArgument && path.isAbsolute(firstArgument) && firstArgument.endsWith('.ndjson')
  ? firstArgument
  : path.join(process.env.HOME || os.tmpdir(), '.chatmux-cua-spawned', agentName + '-' + process.pid + '.ndjson');
const transcriptPath = process.argv[3];
const sessionId = process.argv[4];
const cwd = process.argv[5];
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const emit = (event) => fs.appendFileSync(logPath, JSON.stringify(event) + '\\n');
let transcriptFd;
let turn = 0;
let runningTurn;
const appendRecord = (record) => fs.appendFileSync(transcriptFd, JSON.stringify(record) + '\\n');
const isCodex = agentName === 'codex';
const ensureTranscript = () => {
  if (!transcriptPath || !sessionId || !cwd) return false;
  if (transcriptFd === undefined) {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    transcriptFd = fs.openSync(transcriptPath, 'a');
    appendRecord(isCodex
      ? { type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: sessionId, cwd } }
      : { type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd });
  }
  return true;
};
const appendUserMessage = (text) => appendRecord(isCodex
  ? { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'user_message', message: text } }
  : { type: 'message', id: 'user-' + turn, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } });
const appendAssistantMessage = (text) => appendRecord(isCodex
  ? { type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }
  : { type: 'message', id: 'assistant-' + turn, timestamp: new Date().toISOString(), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } });
const appendTurnEnd = (aborted) => {
  if (isCodex) appendRecord({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: aborted ? 'turn_aborted' : 'turn_complete' } });
};
const finishLongRunningTurn = (text, aborted) => {
  if (transcriptFd !== undefined) {
    appendAssistantMessage(text);
    appendTurnEnd(aborted === true);
    fs.fsyncSync(transcriptFd);
    emit({ type: 'transcript', path: transcriptPath, sessionId });
  }
};
const startLongRunningTurn = () => {
  emit({ type: 'turn_started' });
  runningTurn = setTimeout(() => {
    runningTurn = undefined;
    emit({ type: 'turn_completed' });
    finishLongRunningTurn('long-running fake reply', false);
  }, 10000);
};
const interruptTurn = () => {
  emit({ type: 'interrupt' });
  if (runningTurn !== undefined) {
    clearTimeout(runningTurn);
    runningTurn = undefined;
    emit({ type: 'turn_interrupted' });
    finishLongRunningTurn('interrupted', true);
  }
};
const acceptLine = (value) => {
  emit({ type: 'input', value });
  process.stdout.write('User: ' + value + '\\n');
  turn += 1;
  if (value === '__fake_approval__') {
    emit({ type: 'approval_requested' });
    awaitingApproval = true;
    process.stdout.write('Would you like to run the following command?\\r\\n  echo fleet-approval\\r\\n> 1. Yes, proceed\\r\\n  2. No, cancel\\r\\n');
    return;
  }
  if (value === '__fake_long_running_turn__') {
    if (ensureTranscript()) {
      appendUserMessage(value);
      fs.fsyncSync(transcriptFd);
      emit({ type: 'transcript', path: transcriptPath, sessionId });
    }
    startLongRunningTurn();
    return;
  }
  if (value === '__fake_finish_turn__' && runningTurn !== undefined) {
    clearTimeout(runningTurn);
    runningTurn = undefined;
    emit({ type: 'turn_completed' });
    finishLongRunningTurn('explicit fake reply', false);
    return;
  }
  process.stdout.write('Assistant: fake reply ' + turn + '\\n');
  if (!ensureTranscript()) return;
  appendUserMessage(value);
  appendAssistantMessage('fake reply ' + turn);
  appendTurnEnd(false);
  fs.fsyncSync(transcriptFd);
  emit({ type: 'transcript', path: transcriptPath, sessionId });
};
emit({ type: 'ready', pid: process.pid });
let awaitingApproval = false;
process.stdout.write('ChatMux CUA fixture ready: ' + agentName + '\\n');
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.on('SIGINT', interruptTurn);
let lineBytes = [];
let previousWasCarriageReturn = false;
process.stdin.on('data', (chunk) => {
  for (const byte of chunk) {
    if (awaitingApproval) {
      if (byte === 0x0d || byte === 0x0a) {
        awaitingApproval = false;
        lineBytes = [];
        previousWasCarriageReturn = false;
        emit({ type: 'approval', decision: 'approve' });
        process.stdout.write('Approved.\\r\\n');
      } else if (byte === 0x1b) {
        awaitingApproval = false;
        lineBytes = [];
        previousWasCarriageReturn = false;
        emit({ type: 'approval', decision: 'escape' });
        process.stdout.write('Rejected.\\r\\n');
      }
      continue;
    }
    if (byte === 0x03 || byte === 0x1b) {
      interruptTurn();
      continue;
    }
    if (byte === 0x0d || byte === 0x0a) {
      if (byte === 0x0a && previousWasCarriageReturn) {
        previousWasCarriageReturn = false;
        continue;
      }
      acceptLine(Buffer.from(lineBytes).toString('utf8'));
      lineBytes = [];
      previousWasCarriageReturn = byte === 0x0d;
      continue;
    }
    previousWasCarriageReturn = false;
    lineBytes.push(byte);
  }
});
`, 'utf8');
  await chmod(executablePath, 0o755);
}
