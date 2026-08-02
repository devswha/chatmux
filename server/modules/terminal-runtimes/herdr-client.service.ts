import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import type { HerdrConfiguredSource } from './herdr-config.service.js';

export const HERDR_LIMITS = { version: { timeoutMs: 5_000, stdoutBytes: 256 * 1024, stderrBytes: 64 * 1024 }, schema: { timeoutMs: 10_000, stdoutBytes: 8 * 1024 * 1024, stderrBytes: 64 * 1024 }, snapshot: { timeoutMs: 2_000, stdoutBytes: 4 * 1024 * 1024, stderrBytes: 64 * 1024 }, ndjsonLineBytes: 2 * 1024 * 1024, decodedFrameBytes: 1024 * 1024, inputBytes: 64 * 1024 } as const;
export type HerdrCommandResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; oversized: boolean; stderrOverflow?: boolean; spawnError: boolean };
export type HerdrSpawn = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export type HerdrClock = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
const PANE_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const KEY_RE = /^[A-Za-z0-9+_.@:-]{1,64}$/;
const spawnHerdr: HerdrSpawn = (command, args, options) => spawn(command, args, options) as ChildProcessWithoutNullStreams;

export class HerdrClient {
  constructor(private readonly runSpawn: HerdrSpawn = spawnHerdr, private readonly clock: HerdrClock = globalThis) {}
  private run(source: HerdrConfiguredSource, args: string[], input: string | null, limits: { timeoutMs: number; stdoutBytes: number; stderrBytes: number }): Promise<HerdrCommandResult> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = this.runSpawn(source.binary, args, { shell: false, stdio: 'pipe', windowsHide: true }); } catch { resolve({ code: null, stdout: '', stderr: '', timedOut: false, oversized: false, spawnError: true }); return; }
      let stdout = ''; let stderr = ''; let stdoutBytes = 0; let stderrBytes = 0; const stdoutDecoder = new StringDecoder('utf8'); const stderrChunks: Buffer[] = []; let stderrRetainedBytes = 0; let timedOut = false; let oversized = false; let stderrOverflow = false; let spawnError = false; let settled = false;
      const finish = (code: number | null) => { if (settled) return; settled = true; this.clock.clearTimeout(timer); stdout += stdoutDecoder.end(); stderr = Buffer.concat(stderrChunks, stderrRetainedBytes).toString('utf8'); resolve({ code, stdout, stderr, timedOut, oversized, ...(stderrOverflow ? { stderrOverflow: true } : {}), spawnError }); };
      const stop = (overflow = false) => { oversized = true; stderrOverflow ||= overflow; child.kill('SIGKILL'); };
      const timer = this.clock.setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, limits.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes > limits.stdoutBytes) { stop(); return; } stdout += stdoutDecoder.write(chunk); });
      child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; const retained = Math.min(chunk.length, limits.stderrBytes - stderrRetainedBytes); if (retained > 0) { stderrChunks.push(chunk.subarray(0, retained)); stderrRetainedBytes += retained; } if (stderrBytes > limits.stderrBytes) stop(true); });
      child.once('error', () => { spawnError = true; finish(null); }); child.once('close', finish); child.stdin.end(input ?? undefined);
    });
  }
  private paneId(value: string): string { if (!PANE_ID_RE.test(value)) throw new Error('invalid_pane_id'); return value; }
  version(source: HerdrConfiguredSource): Promise<HerdrCommandResult> { return this.run(source, ['--version'], null, HERDR_LIMITS.version); }
  schema(source: HerdrConfiguredSource): Promise<HerdrCommandResult> { return this.run(source, ['api', 'schema', '--json'], null, HERDR_LIMITS.schema); }
  status(source: HerdrConfiguredSource): Promise<HerdrCommandResult> { return this.run(source, ['--session', source.selector, 'status', 'server'], null, HERDR_LIMITS.version); }
  sessionList(source: HerdrConfiguredSource): Promise<HerdrCommandResult> { return this.run(source, ['session', 'list', '--json'], null, HERDR_LIMITS.snapshot); }
  snapshot(source: HerdrConfiguredSource): Promise<HerdrCommandResult> { return this.run(source, ['--session', source.selector, 'api', 'snapshot'], null, HERDR_LIMITS.snapshot); }
  paneGet(source: HerdrConfiguredSource, paneId: string): Promise<HerdrCommandResult> { return this.run(source, ['--session', source.selector, 'pane', 'get', this.paneId(paneId)], null, HERDR_LIMITS.snapshot); }
  paneRead(source: HerdrConfiguredSource, paneId: string): Promise<HerdrCommandResult> { return this.run(source, ['--session', source.selector, 'pane', 'read', this.paneId(paneId), '--source', 'visible', '--ansi'], null, HERDR_LIMITS.snapshot); }
  paneProcessInfo(source: HerdrConfiguredSource, paneId: string): Promise<HerdrCommandResult> { return this.run(source, ['--session', source.selector, 'pane', 'process-info', '--pane', this.paneId(paneId)], null, HERDR_LIMITS.snapshot); }
  paneSendText(source: HerdrConfiguredSource, paneId: string, text: string): Promise<HerdrCommandResult> { if (!text || text.includes('\0') || Buffer.byteLength(text, 'utf8') > HERDR_LIMITS.inputBytes) throw new Error('invalid_input'); return this.run(source, ['--session', source.selector, 'pane', 'send-text', this.paneId(paneId), text], null, HERDR_LIMITS.snapshot); }
  paneSendKeys(source: HerdrConfiguredSource, paneId: string, keys: readonly string[]): Promise<HerdrCommandResult> { if (!keys.length || keys.length > 64 || keys.some((key) => !KEY_RE.test(key))) throw new Error('invalid_keys'); return this.run(source, ['--session', source.selector, 'pane', 'send-keys', this.paneId(paneId), ...keys], null, HERDR_LIMITS.snapshot); }
  controllerArgv(source: HerdrConfiguredSource, paneId: string, cols: number, rows: number): string[] { if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || cols > 1000 || rows < 1 || rows > 1000) throw new Error('invalid_controller_target'); return ['--session', source.selector, 'terminal', 'session', 'control', this.paneId(paneId), '--cols', String(cols), '--rows', String(rows)]; }
  async ndjson(result: HerdrCommandResult): Promise<unknown[] | null> { if (result.code !== 0 || result.timedOut || result.oversized || result.stderrOverflow || result.spawnError) return null; const lines = result.stdout.split('\n'); if (lines.at(-1) === '') lines.pop(); if (lines.some((line) => Buffer.byteLength(line, 'utf8') > HERDR_LIMITS.ndjsonLineBytes)) return null; try { return lines.map((line) => JSON.parse(line)); } catch { return null; } }
}
