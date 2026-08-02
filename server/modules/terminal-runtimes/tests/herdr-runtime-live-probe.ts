import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HerdrRuntimeAdapter } from '../herdr-runtime-adapter.service.js';
import { readHerdrRuntimeConfig } from '../herdr-config.service.js';
import { RuntimeOperationPolicyService } from '../runtime-operation-policy.service.js';

const EXPECTED_SHA256 = '3dc83288073e4c2d3c679a30e7be97bcca9141c6fd17dbbb9219142e95c59253';
const REPORT_PATH = join(process.cwd(), 'artifacts', 'herdr-v1-live-report.json');

type Report = {
  schemaVersion: 1;
  kind: 'black-box-api-test-report';
  passed: boolean;
  execution: { command: string[]; cwd: '.'; requiredEnvironment: string[]; expectedAssetSha256: string; exitCode: number | null };
  checks: Record<string, unknown>;
  cleanup: Record<string, unknown>;
};

async function main(): Promise<void> {
  const asset = process.env.CHATMUX_HERDR_TEST_ASSET;
  if (!asset) throw new Error('CHATMUX_HERDR_TEST_ASSET is required');
  const root = await mkdtemp(join(tmpdir(), 'chatmux-herdr-v1-'));
  const binary = join(root, 'herdr');
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const configHome = join(root, 'config');
  const stateHome = join(root, 'state');
  const cacheHome = join(root, 'cache');
  const dataHome = join(root, 'data');
  const configPath = join(configHome, 'herdr', 'config.toml');
  const session = `chatmux-v1-${randomBytes(6).toString('hex')}`;
  const marker = `CHATMUX_HERDR_V1_${randomBytes(8).toString('hex')}`;
  let server: ReturnType<typeof spawn> | null = null;
  let paneId = '';
  const report: Report = {
    schemaVersion: 1,
    kind: 'black-box-api-test-report',
    passed: false,
    execution: {
      command: ['node', '--import', 'tsx', 'server/modules/terminal-runtimes/tests/herdr-runtime-live-probe.ts'],
      cwd: '.',
      requiredEnvironment: ['CHATMUX_HERDR_TEST_ASSET'],
      expectedAssetSha256: EXPECTED_SHA256,
      exitCode: null,
    },
    checks: {},
    cleanup: {},
  };

  for (const directory of [home, workspace, configHome, stateHome, cacheHome, dataHome, join(configHome, 'herdr')]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await copyFile(asset, binary);
  await chmod(binary, 0o755);
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  if (sha256 !== EXPECTED_SHA256) throw new Error('asset digest mismatch');
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_DATA_HOME: dataHome,
    HERDR_CONFIG_PATH: configPath,
  };
  Object.assign(process.env, env);
  const run = (args: string[], allowFailure = false) => {
    const result = spawnSync(binary, args, { env, encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
    if (!allowFailure && result.status !== 0) throw new Error(`Herdr command failed: ${args[0] ?? 'unknown'}`);
    return result;
  };
  const json = (args: string[]): Record<string, unknown> => JSON.parse(run(args).stdout) as Record<string, unknown>;
  const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timeout: ${label}`);
  };

  try {
    server = spawn(binary, ['--session', session, 'server'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFor(() => run(['--session', session, 'status', 'server'], true).stdout.includes('status: running'), 'server');
    const created = json(['--session', session, 'workspace', 'create', '--cwd', workspace, '--label', 'chatmux-v1-live', '--no-focus']);
    const createdResult = created.result as { root_pane?: { pane_id?: string } } | undefined;
    paneId = createdResult?.root_pane?.pane_id ?? '';
    if (!paneId) throw new Error('workspace creation omitted pane');
    run(['--session', session, 'pane', 'run', paneId, `printf '\\033[32m${marker} 한글🐑\\033[0m\\n'`]);
    await waitFor(() => run(['--session', session, 'pane', 'read', paneId, '--source', 'visible', '--ansi']).stdout.includes(marker), 'seed output');

    const config = readHerdrRuntimeConfig({
      CHATMUX_HERDR_RUNTIME: '1',
      CHATMUX_HERDR_SOURCES: JSON.stringify([{ alias: 'liveprobe', selector: session, binary }]),
      CHATMUX_HERDR_CAPABILITIES: 'discovery,output,actions,attach',
    });
    if (!config.enabled || config.sources.length !== 1) throw new Error(`config rejected: ${config.errorCode}`);
    const policy = new RuntimeOperationPolicyService(config.startupCapabilities, config.sources.map((source) => source.sourceId));
    const adapter = new HerdrRuntimeAdapter(config, policy, undefined, undefined, () => 'discovery-placeholder-capability');
    const [descriptor] = await adapter.sourceDescriptors();
    const [target] = await adapter.discover();
    if (descriptor?.readiness !== 'ready' || !target || target.runtime !== 'herdr') {
      throw new Error(`discovery/readiness mismatch: ${JSON.stringify({ descriptor, target })}`);
    }
    const ref = { runtime: 'herdr' as const, sourceId: target.sourceId, targetId: target.targetId };
    const output = await adapter.read(ref);
    const outputFresh = await adapter.verify(ref, 'output');
    const attachFresh = await adapter.verify(ref, 'attach');
    const actionAllowed = await adapter.verify(ref, 'actions');
    if (!output?.ansi.includes(marker) || !outputFresh || !attachFresh || actionAllowed) throw new Error('runtime operation mismatch');

    const controller = await adapter.controllerArgv(ref, 80, 24);
    const duplicate = await adapter.controllerArgv(ref, 80, 24);
    if (!controller || duplicate !== null) throw new Error('controller lease mismatch');
    const child = spawn(controller.command, controller.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffered = '';
    const frames: Array<{ type?: string; width?: number; height?: number }> = [];
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) frames.push(JSON.parse(line) as { type?: string; width?: number; height?: number });
        newline = buffered.indexOf('\n');
      }
    });
    await waitFor(() => frames.some((frame) => frame.type === 'terminal.frame'), 'initial controller frame');
    child.stdin.write(`${JSON.stringify({ type: 'terminal.resize', cols: 100, rows: 30 })}\n`);
    await waitFor(() => frames.some((frame) => frame.width === 100 && frame.height === 30), 'resize frame');
    child.stdin.write(`${JSON.stringify({ type: 'terminal.release' })}\n`);
    child.stdin.end();
    await new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
    controller.release();
    const reacquired = await adapter.controllerArgv(ref, 80, 24);
    if (!reacquired) throw new Error('controller was not reacquirable');
    reacquired.release();

    run(['--session', session, 'server', 'stop']);
    await waitFor(() => !run(['--session', session, 'status', 'server'], true).stdout.includes('status: running'), 'server stop');
    server = spawn(binary, ['--session', session, 'server'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFor(() => run(['--session', session, 'status', 'server'], true).stdout.includes('status: running'), 'server restart');
    const staleTargetDenied = !(await adapter.verify(ref, 'attach'));
    if (!staleTargetDenied) throw new Error('stale target survived source restart');
    adapter.dispose();

    report.passed = true;
    report.checks = {
      provenanceSha256: sha256,
      readiness: descriptor.readiness,
      targetClass: target.targetClass,
      outputMarkerObserved: true,
      outputFresh,
      attachFresh,
      genericPaneActionsDenied: !actionAllowed,
      duplicateControllerDenied: duplicate === null,
      resizeFrameObserved: frames.some((frame) => frame.width === 100 && frame.height === 30),
      reacquiredAfterRelease: true,
      staleTargetDeniedAfterSourceRestart: staleTargetDenied,
      productManagedCreationUsed: false,
    };
  } finally {
    run(['--session', session, 'server', 'stop'], true);
    if (server && server.exitCode === null) server.kill('SIGTERM');
    const deleted = run(['session', 'delete', session, '--json'], true);
    const sessions = run(['session', 'list', '--json'], true);
    report.cleanup = {
      serverStopped: true,
      sessionDeleteExit: deleted.status,
      sessionAbsent: !sessions.stdout.includes(session),
    };
    await rm(root, { recursive: true, force: true });
    report.cleanup.runRootAbsent = await stat(root).then(() => false, () => true);
    await mkdir(join(process.cwd(), 'artifacts'), { recursive: true });
    report.execution.exitCode = report.passed ? 0 : 1;
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  if (!report.passed || !report.cleanup.sessionAbsent || !report.cleanup.runRootAbsent) throw new Error('live probe failed');
  console.log(REPORT_PATH);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
