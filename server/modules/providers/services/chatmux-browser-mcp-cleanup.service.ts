import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import path from 'path';

import Database from 'better-sqlite3';
import TOML from '@iarna/toml';
import { applyEdits, modify, parse, parseTree, type ParseError } from 'jsonc-parser';

import { getDatabasePath } from '@/modules/database/index.js';
import { findServerRoot, getModuleDir } from '@/utils/runtime-paths.js';

export type CleanupClassification =
  | 'absent'
  | 'exact-managed'
  | 'same-name-nonmatching-user-owned'
  | 'partial-or-unknown blocker'
  | 'parse-error blocker'
  | 'unsupported-read-only';
export type CleanupStatus =
  | 'blocked'
  | 'completed'
  | 'completed_noop'
  | 'failed_compensated'
  | 'rollback_conflict'
  | 'rolled_back';
export type ProviderName = 'claude' | 'cursor' | 'codex' | 'opencode' | 'gjc' | 'omp';

type ProviderWriteStatus = 'untouched' | 'written' | 'restored' | 'conflict';
type JsonObject = Record<string, unknown>;
type ProviderFile = [ProviderName, string | null, string | null];

export interface CleanupProviderResult {
  provider: ProviderName;
  path: string | null;
  classification: CleanupClassification;
  status: ProviderWriteStatus;
}

export interface CleanupResult {
  runId: string;
  receiptPath: string;
  status: CleanupStatus;
  providers: CleanupProviderResult[];
}

export interface BrowserMcpCleanupDependencies {
  homeDir?: string;
  uid?: number;
  gid?: number;
  execPath?: string;
  serverScriptPath?: string;
  port?: string;
  token?: () => string | null;
  isLiveServer?: () => boolean;
  randomUUID?: () => string;
}

interface CleanupDependencies {
  homeDir: string;
  uid: number;
  gid: number;
  execPath: string;
  serverScriptPath: string;
  port: string;
  token: () => string | null;
  isLiveServer: () => boolean;
  randomUUID: () => string;
}

interface Inventory {
  provider: ProviderName;
  file: string | null;
  exists: boolean;
  bytes?: Buffer;
  stat?: fs.Stats;
  classification: CleanupClassification;
  postimage?: Buffer;
  written?: boolean;
  restored?: boolean;
  error?: string;
  unselected?: string | null;
  target?: unknown;
  expectedOwnershipFingerprint?: string;
}

interface ReceiptProvider extends Record<string, unknown> {
  provider: ProviderName;
  path: string | null;
  unselectedPath?: string | null;
  exists: boolean;
  classification: CleanupClassification;
  preimageSha256?: string;
  target?: unknown;
  expectedOwnershipFingerprint?: string;
  preimageSemanticHash?: string;
  originalMode?: number;
  uid?: number;
  gid?: number;
  mtimeMs?: number;
  postimageSha256?: string;
  postimageSemanticHash?: string;
  writeState: 'written' | 'untouched';
  restoreState?: 'restored' | 'conflict';
  error?: string;
}

interface Receipt {
  runId: string;
  status: CleanupStatus | 'inventory-complete';
  providers: ReceiptProvider[];
  staleMarker: boolean;
  startedAt: string;
}

const NAME = 'chatmux-browser';
const MODES = {
  root: 0o700,
  lock: 0o600,
  run: 0o700,
  receipt: 0o600,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVER_ROOT = findServerRoot(getModuleDir(import.meta.url));

function digest(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_, nestedValue) => {
    if (!nestedValue || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) {
      return nestedValue;
    }

    const object = nestedValue as JsonObject;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
  });
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function targetFor(provider: ProviderName): string[] {
  if (provider === 'codex') {
    return ['mcp_servers', NAME];
  }

  if (provider === 'opencode') {
    return ['mcp', NAME];
  }

  return ['mcpServers', NAME];
}

function jsonRemove(text: string, target: string[]): Buffer {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (!tree || errors.length > 0) {
    throw new Error('JSON/JSONC parse error');
  }

  const edits = modify(text, target, undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  return Buffer.from(applyEdits(text, edits));
}

function jsonCandidate(bytes: Buffer, target: string[]): unknown {
  const errors: ParseError[] = [];
  const value = parse(bytes.toString('utf8'), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0 || !value || typeof value !== 'object') {
    throw new Error('JSON/JSONC parse error');
  }

  return target.reduce<unknown>((item, key) => {
    if (!item || typeof item !== 'object') {
      return undefined;
    }

    return (item as JsonObject)[key];
  }, value);
}
function normalizedPath(value: string): string {
  return path.resolve(value);
}

function readBrowserMcpToken(): string | null {
  let database: Database.Database | undefined;
  try {
    database = new Database(getDatabasePath(), { readonly: true, fileMustExist: true });
    const row = database
      .prepare('SELECT value FROM app_config WHERE key = ?')
      .get('browser_use_mcp_token') as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

function ownershipFingerprint(
  provider: ProviderName,
  dependencies: Pick<CleanupDependencies, 'execPath' | 'serverScriptPath' | 'port'>,
  token: string | null,
): string | undefined {
  if (!token) {
    return undefined;
  }

  return digest(Buffer.from(stable({
    provider,
    command: dependencies.execPath,
    args: [dependencies.serverScriptPath],
    token,
    url: `http://127.0.0.1:${dependencies.port}/api/browser-use-mcp`,
  })));
}

function commandMatches(
  provider: ProviderName,
  candidate: unknown,
  dependencies: Pick<CleanupDependencies, 'execPath' | 'serverScriptPath'>,
): boolean {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const config = candidate as JsonObject;
  const commandAndArgsMatch = (command: unknown, args: unknown): boolean => {
    if (
      typeof command !== 'string'
      || !Array.isArray(args)
      || args.length !== 1
      || typeof args[0] !== 'string'
    ) {
      return false;
    }

    return (
      (normalizedPath(command) === dependencies.execPath
        && normalizedPath(args[0]) === dependencies.serverScriptPath)
      || (command === 'chatmux' && args[0] === 'browser-use-mcp')
    );
  };

  if (provider === 'opencode') {
    const command = config.command;
    const commandParts = Array.isArray(command) ? command : undefined;
    return (
      config.type === 'local'
      && config.enabled === true
      && commandParts !== undefined
      && commandAndArgsMatch(commandParts[0], commandParts.slice(1))
    );
  }

  return commandAndArgsMatch(config.command, config.args);
}

function exactCandidate(
  provider: ProviderName,
  candidate: unknown,
  dependencies: Pick<CleanupDependencies, 'execPath' | 'serverScriptPath' | 'port'> & {
    token: string | null;
  },
): boolean {
  if (!commandMatches(provider, candidate, dependencies) || !dependencies.token) {
    return false;
  }

  const config = candidate as JsonObject;
  const environment = provider === 'opencode' ? config.environment : config.env;
  const expectedKeys = expectedCandidateKeys(provider);

  if (
    !environment
    || typeof environment !== 'object'
    || Object.keys(config).sort().join(',') !== expectedKeys.join(',')
  ) {
    return false;
  }

  const environmentValues = environment as JsonObject;
  const environmentKeys = Object.keys(environmentValues).sort();
  if (environmentKeys.join(',') !== 'CHATMUX_BROWSER_USE_API_URL,CHATMUX_BROWSER_USE_MCP_TOKEN') {
    return false;
  }

  if ((provider === 'claude' || provider === 'cursor') && config.type !== 'stdio') {
    return false;
  }

  if (provider === 'codex' && (!Array.isArray(config.env_vars) || config.env_vars.length !== 0)) {
    return false;
  }

  try {
    return (
      environmentValues.CHATMUX_BROWSER_USE_MCP_TOKEN === dependencies.token
      && normalizeUrl(environmentValues.CHATMUX_BROWSER_USE_API_URL as string)
        === normalizeUrl(`http://127.0.0.1:${dependencies.port}/api/browser-use-mcp`)
    );
  } catch {
    return false;
  }
}

function expectedCandidateKeys(provider: ProviderName): string[] {
  if (provider === 'opencode') {
    return ['command', 'enabled', 'environment', 'type'];
  }

  if (provider === 'codex') {
    return ['args', 'command', 'env', 'env_vars'];
  }

  return ['args', 'command', 'env', 'type'];
}

function tomlRemove(text: string): Buffer {
  const lines = text.split(/(?<=\n)/);
  const header = /^\s*\[\s*(?:mcp_servers\.chatmux-browser|mcp_servers\."chatmux-browser"|"mcp_servers"\."chatmux-browser")\s*\]\s*(?:#.*)?$/;
  const descendant = /^\s*\[\s*(?:mcp_servers\.chatmux-browser|mcp_servers\."chatmux-browser"|"mcp_servers"\."chatmux-browser")\./;
  const start = lines.findIndex((line) => header.test(line));

  if (start < 0) {
    throw new Error('TOML target is not a dedicated table');
  }

  let end = start + 1;
  while (end < lines.length) {
    if (/^\s*\[/.test(lines[end]) && !descendant.test(lines[end])) {
      break;
    }

    end += 1;
  }

  return Buffer.from(lines.slice(0, start).concat(lines.slice(end)).join(''));
}

function tomlCandidate(bytes: Buffer): unknown {
  try {
    const document = TOML.parse(bytes.toString('utf8')) as JsonObject | null | undefined;
    const servers = document?.mcp_servers as JsonObject | undefined;
    return servers?.[NAME];
  } catch {
    throw new Error('TOML parse error');
  }
}

function semanticDeletionValid(provider: ProviderName, before: Buffer, after: Buffer): boolean {
  try {
    if (provider === 'codex') {
      const original = TOML.parse(before.toString('utf8')) as JsonObject | null | undefined;
      const edited = TOML.parse(after.toString('utf8')) as JsonObject | null | undefined;
      const originalServers = original?.mcp_servers as JsonObject | undefined;

      delete originalServers?.[NAME];
      if (originalServers && Object.keys(originalServers).length === 0) {
        delete original?.mcp_servers;
      }

      return stable(original) === stable(edited);
    }

    const errors: ParseError[] = [];
    const original = parse(before.toString('utf8'), errors, {
      allowTrailingComma: true,
      disallowComments: false,
    }) as JsonObject;
    const edited = parse(after.toString('utf8'), errors, {
      allowTrailingComma: true,
      disallowComments: false,
    }) as JsonObject;

    if (errors.length > 0) {
      return false;
    }

    const parent = targetFor(provider)
      .slice(0, -1)
      .reduce<unknown>((item, key) => (item as JsonObject | undefined)?.[key], original) as JsonObject | undefined;
    delete parent?.[NAME];
    return stable(original) === stable(edited);
  } catch {
    return false;
  }
}

export class ChatmuxBrowserMcpCleanupService {
  private readonly d: CleanupDependencies;

  constructor(dependencies: BrowserMcpCleanupDependencies = {}) {
    const homeDir = dependencies.homeDir ?? os.homedir();
    this.d = {
      homeDir,
      uid: dependencies.uid ?? process.getuid?.() ?? 0,
      gid: dependencies.gid ?? process.getgid?.() ?? 0,
      execPath: normalizedPath(dependencies.execPath ?? process.execPath),
      serverScriptPath: normalizedPath(
        dependencies.serverScriptPath ?? path.join(SERVER_ROOT, 'browser-use-mcp.js'),
      ),
      port: dependencies.port ?? process.env.SERVER_PORT ?? process.env.PORT ?? '3001',
      token: dependencies.token ?? readBrowserMcpToken,
      isLiveServer: dependencies.isLiveServer ?? (() => this.defaultLiveServer()),
      randomUUID: dependencies.randomUUID ?? crypto.randomUUID,
    };
  }

  private root(): string {
    return path.join(this.d.homeDir, '.chatmux/data/migrations/browser-mcp-cleanup');
  }

  private assertDirectory(directory: string, create = false): void {
    if (create && !fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true, mode: MODES.root });
    }

    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.d.uid || (stat.mode & 0o022)) {
      throw new Error(`Unsafe migration directory: ${directory}`);
    }
  }

  private defaultLiveServer(): boolean {
    const marker = path.join(this.d.homeDir, '.chatmux/local-server.json');

    try {
      const pid = Number(JSON.parse(fs.readFileSync(marker, 'utf8')).pid);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EPERM') {
            return true;
          }
        }
      }
    } catch {
      // A missing, malformed, or stale marker is recorded but does not block cleanup.
    }

    try {
      execFileSync(
        process.execPath,
        ['-e', "const http=require('http');const port=process.argv[1];const request=http.get({host:'127.0.0.1',port,path:'/health',timeout:250},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>{try{const health=JSON.parse(body);process.exit(health.product==='chatmux'&&health.protocolVersion===1?0:1)}catch{process.exit(1)}})});request.on('error',()=>process.exit(1));request.on('timeout',()=>{request.destroy();process.exit(1)})", this.d.port],
        { stdio: 'ignore', timeout: 500 },
      );
      return true;
    } catch {
      return false;
    }
  }

  private lock(runId: string): () => void {
    const file = path.join(this.root(), 'migration.lock');
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
    const descriptor = fs.openSync(file, flags, MODES.lock);

    try {
      fs.writeFileSync(descriptor, `${process.pid} ${runId} ${new Date().toISOString()}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    return () => fs.unlinkSync(file);
  }

  private providerFiles(): ProviderFile[] {
    const openCodeJson = path.join(this.d.homeDir, '.config/opencode/opencode.json');
    const openCodeJsonc = `${openCodeJson}c`;
    const unselectedOpenCodeFile =
      fs.existsSync(openCodeJson) && fs.existsSync(openCodeJsonc) ? openCodeJsonc : null;

    return [
      ['claude', path.join(this.d.homeDir, '.claude.json'), null],
      ['cursor', path.join(this.d.homeDir, '.cursor/mcp.json'), null],
      ['codex', path.join(this.d.homeDir, '.codex/config.toml'), null],
      [
        'opencode',
        fs.existsSync(openCodeJson) ? openCodeJson : openCodeJsonc,
        unselectedOpenCodeFile,
      ],
      ['gjc', null, null],
      ['omp', null, null],
    ];
  }

  private read(provider: ProviderName, file: string | null, unselected: string | null): Inventory {
    if (!file) {
      return { provider, file, exists: false, classification: 'unsupported-read-only' };
    }

    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== this.d.uid || (stat.mode & 0o022)) {
        throw new Error('unsafe provider file');
      }

      const bytes = fs.readFileSync(file);
      if (provider === 'codex') {
        return this.readCodex(provider, file, unselected, bytes, stat);
      }

      const candidate = jsonCandidate(bytes, targetFor(provider));
      return this.classifyCandidate(provider, file, unselected, bytes, stat, candidate);
    } catch (error) {
      return this.readError(provider, file, unselected, error);
    }
  }

  private readCodex(
    provider: ProviderName,
    file: string,
    unselected: string | null,
    bytes: Buffer,
    stat: fs.Stats,
  ): Inventory {
    const candidate = tomlCandidate(bytes);
    if (candidate === undefined) {
      return { provider, file, exists: true, bytes, stat, classification: 'absent', unselected };
    }

    try {
      tomlRemove(bytes.toString());
    } catch {
      return {
        provider,
        file,
        exists: true,
        bytes,
        stat,
        classification: 'partial-or-unknown blocker',
        unselected,
      };
    }

    return this.classifyCandidate(provider, file, unselected, bytes, stat, candidate);
  }

  private classifyCandidate(
    provider: ProviderName,
    file: string,
    unselected: string | null,
    bytes: Buffer,
    stat: fs.Stats,
    candidate: unknown,
  ): Inventory {
    if (candidate === undefined) {
      return { provider, file, exists: true, bytes, stat, classification: 'absent', unselected };
    }

    const token = this.d.token();
    const exactDependencies = { ...this.d, token };
    const classification = exactCandidate(provider, candidate, exactDependencies)
      ? 'exact-managed'
      : commandMatches(provider, candidate, this.d)
        ? 'partial-or-unknown blocker'
        : 'same-name-nonmatching-user-owned';

    return {
      provider,
      file,
      exists: true,
      bytes,
      stat,
      classification,
      unselected,
      target: candidate,
      expectedOwnershipFingerprint: ownershipFingerprint(provider, this.d, token),
    };
  }

  private readError(
    provider: ProviderName,
    file: string,
    unselected: string | null,
    error: unknown,
  ): Inventory {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { provider, file, exists: false, classification: 'absent', unselected };
    }

    const message = error instanceof Error ? error.message : String(error);
    const classification = String(error).includes('parse')
      ? 'parse-error blocker'
      : 'partial-or-unknown blocker';
    return { provider, file, exists: true, classification, error: message, unselected };
  }

  private receipt(
    runId: string,
    status: Receipt['status'],
    inventory: Inventory[],
    staleMarker: boolean,
  ): Receipt {
    return {
      runId,
      status,
      staleMarker,
      startedAt: new Date().toISOString(),
      providers: inventory.map((entry) => this.receiptProvider(entry)),
    };
  }

  private receiptProvider(entry: Inventory): ReceiptProvider {
    return {
      provider: entry.provider,
      path: entry.file,
      unselectedPath: entry.unselected,
      exists: entry.exists,
      classification: entry.classification,
      target: entry.target,
      expectedOwnershipFingerprint: entry.expectedOwnershipFingerprint,
      preimageSha256: entry.bytes && digest(entry.bytes),
      preimageSemanticHash: entry.bytes && this.semanticHash(entry.provider, entry.bytes),
      originalMode: entry.stat && (entry.stat.mode & 0o777),
      uid: entry.stat?.uid,
      gid: entry.stat?.gid,
      mtimeMs: entry.stat?.mtimeMs,
      postimageSha256: entry.postimage && digest(entry.postimage),
      postimageSemanticHash:
        entry.postimage && this.semanticHash(entry.provider, entry.postimage),
      writeState: entry.written ? 'written' : 'untouched',
      error: entry.error,
    };
  }

  private semanticHash(provider: ProviderName, bytes: Buffer): string | undefined {
    try {
      const document =
        provider === 'codex'
          ? TOML.parse(bytes.toString('utf8'))
          : parse(bytes.toString('utf8'), [], {
              allowTrailingComma: true,
              disallowComments: false,
            });
      return crypto.createHash('sha256').update(stable(document)).digest('hex');
    } catch {
      return undefined;
    }
  }

  private writeReceipt(runDir: string, receipt: Receipt): void {
    const file = path.join(runDir, 'receipt.json');
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2), { mode: MODES.receipt });
    fs.chmodSync(file, MODES.receipt);

    const descriptor = fs.openSync(file, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private atomic(
    file: string,
    bytes: Buffer,
    stat: fs.Stats,
    restoreMetadata = false,
    onRename?: () => void,
  ): void {
    const temporaryFile = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${crypto.randomUUID()}.tmp`,
    );
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
    const descriptor = fs.openSync(temporaryFile, flags, stat.mode & 0o777);

    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    try {
      fs.chmodSync(temporaryFile, stat.mode & 0o777);
      fs.chownSync(temporaryFile, stat.uid, stat.gid);
      if (restoreMetadata && typeof stat.mtimeMs === 'number') {
        fs.utimesSync(temporaryFile, new Date(stat.mtimeMs), new Date(stat.mtimeMs));
      }
      fs.renameSync(temporaryFile, file);
      onRename?.();
    } catch (error) {
      try {
        fs.unlinkSync(temporaryFile);
      } catch {
        // Preserve the original write error.
      }
      throw error;
    }

    const directoryDescriptor = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  }

  private edit(entry: Inventory): Buffer {
    if (entry.provider === 'codex') {
      return tomlRemove(entry.bytes!.toString());
    }

    return jsonRemove(entry.bytes!.toString(), targetFor(entry.provider));
  }

  apply(): CleanupResult {
    const runId = this.d.randomUUID();
    if (!UUID.test(runId)) {
      throw new Error('randomUUID returned invalid UUID');
    }

    this.assertDirectory(this.root(), true);
    if (this.d.isLiveServer()) {
      throw new Error('ChatMux local server appears live; refusing cleanup');
    }

    const release = this.lock(runId);
    const runDir = path.join(this.root(), runId);
    let inventory: Inventory[] = [];

    try {
      fs.mkdirSync(runDir, { mode: MODES.run });
      fs.mkdirSync(path.join(runDir, 'backups'), { mode: MODES.run });
      inventory = this.providerFiles().map(([provider, file, unselected]) =>
        this.read(provider, file, unselected),
      );
      this.writeBackups(runDir, inventory);
      this.writeReceipt(
        runDir,
        this.receipt(
          runId,
          'inventory-complete',
          inventory,
          fs.existsSync(path.join(this.d.homeDir, '.chatmux/local-server.json')),
        ),
      );

      if (inventory.some((entry) => entry.classification.endsWith(' blocker'))) {
        const status: CleanupStatus = 'blocked';
        this.writeReceipt(runDir, this.receipt(runId, status, inventory, false));
        return this.result(runId, runDir, status, inventory);
      }

      return this.applyManagedEntries(runId, runDir, inventory);
    } finally {
      release();
    }
  }

  private writeBackups(runDir: string, inventory: Inventory[]): void {
    const backupDirectory = path.join(runDir, 'backups');
    for (const entry of inventory.filter((candidate) => candidate.bytes)) {
      const file = path.join(backupDirectory, `${entry.provider}.preimage`);
      const descriptor = fs.openSync(
        file,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
        MODES.receipt,
      );
      try {
        fs.writeFileSync(descriptor, entry.bytes!);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.chmodSync(file, MODES.receipt);
    }

    const descriptor = fs.openSync(backupDirectory, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private applyManagedEntries(runId: string, runDir: string, inventory: Inventory[]): CleanupResult {
    const written: Inventory[] = [];

    try {
      for (const entry of inventory.filter(
        (candidate) => candidate.classification === 'exact-managed',
      )) {
        written.push(entry);
        this.writeManagedEntry(entry);
      }
    } catch {
      const status = this.compensate(written) ? 'failed_compensated' : 'rollback_conflict';
      this.writeReceipt(runDir, this.receipt(runId, status, inventory, false));
      return this.result(runId, runDir, status, inventory);
    }

    const status: CleanupStatus = written.length > 0 ? 'completed' : 'completed_noop';
    this.writeReceipt(runDir, this.receipt(runId, status, inventory, false));
    return this.result(runId, runDir, status, inventory);
  }

  private writeManagedEntry(entry: Inventory): void {
    const current = fs.readFileSync(entry.file!);
    if (digest(current) !== digest(entry.bytes!)) {
      throw new Error(`CAS mismatch: ${entry.provider}`);
    }

    entry.postimage = this.edit(entry);
    if (!semanticDeletionValid(entry.provider, entry.bytes!, entry.postimage)) {
      throw new Error(`semantic diff rejected: ${entry.provider}`);
    }

    this.atomic(entry.file!, entry.postimage, entry.stat!, false, () => {
      entry.written = true;
    });
    if (!this.matches(entry, entry.postimage, this.semanticHash(entry.provider, entry.postimage))) {
      throw new Error(`post-write verification failed: ${entry.provider}`);
    }
  }

  private compensate(written: Inventory[]): boolean {
    let allCompensated = true;

    for (const entry of [...written].reverse()) {
      if (!entry.written || !entry.postimage) {
        continue;
      }

      try {
        if (!this.matches(entry, entry.postimage, this.semanticHash(entry.provider, entry.postimage))) {
          throw new Error('CAS restore conflict');
        }
        this.atomic(entry.file!, entry.bytes!, entry.stat!, true);
        if (!this.matches(entry, entry.bytes!, this.semanticHash(entry.provider, entry.bytes!))) {
          throw new Error('restore verification failed');
        }
        entry.written = false;
      } catch (error) {
        allCompensated = false;
        entry.error = error instanceof Error ? error.message : 'restore failed';
      }
    }

    return allCompensated;
  }

  rollback(runId: string): CleanupResult {
    if (!UUID.test(runId)) {
      throw new Error('Invalid run ID');
    }

    this.assertDirectory(this.root());
    const release = this.lock(runId);
    const runDir = path.join(this.root(), runId);

    try {
      this.assertDirectory(runDir);
      const receipt = this.readReceipt(runDir);
      if (!['completed', 'completed_noop'].includes(receipt.status)) {
        throw new Error('Receipt is not rollback eligible');
      }

      const inventory = receipt.providers.map((provider) =>
        this.inventoryFromReceipt(runDir, provider),
      );
      const written = inventory.filter((entry) => entry.written);

      if (this.rollbackHasConflict(receipt, written)) {
        this.writeReceipt(runDir, { ...receipt, status: 'rollback_conflict' });
        return this.result(runId, runDir, 'rollback_conflict', inventory);
      }

      const restored: Inventory[] = [];
      try {
        for (const entry of [...written].reverse()) {
          this.atomic(entry.file!, entry.bytes!, entry.stat!, true, () => {
            restored.push(entry);
          });
          if (!this.matches(entry, entry.bytes!, this.semanticHash(entry.provider, entry.bytes!))) {
            throw new Error(`restore verification failed: ${entry.provider}`);
          }
          entry.written = false;
          entry.restored = true;
        }
      } catch {
        const status: CleanupStatus = this.restoreForward(receipt, restored)
          ? 'failed_compensated'
          : 'rollback_conflict';
        this.writeReceipt(runDir, { ...receipt, status });
        return this.result(runId, runDir, status, inventory);
      }

      this.writeReceipt(runDir, { ...receipt, status: 'rolled_back' });
      return this.result(runId, runDir, 'rolled_back', inventory);
    } finally {
      release();
    }
  }

  private readReceipt(runDir: string): Receipt {
    return JSON.parse(fs.readFileSync(path.join(runDir, 'receipt.json'), 'utf8')) as Receipt;
  }

  private inventoryFromReceipt(runDir: string, provider: ReceiptProvider): Inventory {
    const bytes = provider.preimageSha256
      ? fs.readFileSync(path.join(runDir, 'backups', `${provider.provider}.preimage`))
      : undefined;
    if (bytes && (digest(bytes) !== provider.preimageSha256
      || this.semanticHash(provider.provider, bytes) !== provider.preimageSemanticHash)) {
      throw new Error(`Invalid preimage backup: ${provider.provider}`);
    }

    return {
      provider: provider.provider,
      file: provider.path,
      exists: provider.exists,
      classification: provider.classification,
      bytes,
      written: provider.writeState === 'written',
      stat:
        provider.originalMode === undefined
          ? undefined
          : ({
              mode: provider.originalMode,
              uid: provider.uid,
              gid: provider.gid,
              mtimeMs: provider.mtimeMs,
            } as fs.Stats),
    };
  }

  private rollbackHasConflict(receipt: Receipt, written: Inventory[]): boolean {
    return written.some((entry) => {
      const provider = receipt.providers.find((candidate) => candidate.provider === entry.provider);
      try {
        return !provider
          || !provider.postimageSha256
          || !this.matches(entry, undefined, provider.postimageSemanticHash, provider.postimageSha256);
      } catch {
        return true;
      }
    });
  }

  private restoreForward(receipt: Receipt, restored: Inventory[]): boolean {
    let allCompensated = true;
    for (const entry of [...restored].reverse()) {
      const provider = receipt.providers.find((candidate) => candidate.provider === entry.provider);
      try {
        if (!provider?.postimageSha256 || !entry.bytes
          || digest(fs.readFileSync(entry.file!)) !== digest(entry.bytes)) {
          throw new Error('forward compensation conflict');
        }
        const postimage = this.edit(entry);
        if (digest(postimage) !== provider.postimageSha256
          || this.semanticHash(entry.provider, postimage) !== provider.postimageSemanticHash) {
          throw new Error('forward compensation verification failed');
        }
        this.atomic(entry.file!, postimage, entry.stat!);
        if (!this.matches(entry, postimage, this.semanticHash(entry.provider, postimage))) {
          throw new Error('forward compensation verification failed');
        }
        entry.written = true;
      } catch (error) {
        allCompensated = false;
        entry.error = error instanceof Error ? error.message : 'forward compensation failed';
      }
    }
    return allCompensated;
  }

  private matches(
    entry: Inventory,
    bytes?: Buffer,
    semanticHash?: string,
    expectedDigest?: string,
  ): boolean {
    const current = fs.readFileSync(entry.file!);
    const stat = fs.statSync(entry.file!);
    const expectedBytes = bytes ? digest(bytes) : expectedDigest;
    return Boolean(
      expectedBytes
      && digest(current) === expectedBytes
      && this.semanticHash(entry.provider, current) === semanticHash
      && stat.uid === entry.stat!.uid
      && stat.gid === entry.stat!.gid
      && (stat.mode & 0o777) === (entry.stat!.mode & 0o777)
      && (bytes !== entry.bytes || Math.abs(stat.mtimeMs - entry.stat!.mtimeMs) < 1),
    );
  }

  private result(
    runId: string,
    runDir: string,
    status: CleanupStatus,
    inventory: Inventory[],
  ): CleanupResult {
    return {
      runId,
      receiptPath: path.join(runDir, 'receipt.json'),
      status,
      providers: inventory.map((entry) => ({
        provider: entry.provider,
        path: entry.file,
        classification: entry.classification,
        status: this.providerResultStatus(entry, status),
      })),
    };
  }

  private providerResultStatus(entry: Inventory, status: CleanupStatus): ProviderWriteStatus {
    if (status === 'rolled_back' && entry.restored) {
      return 'restored';
    }

    if (entry.written) {
      return 'written';
    }

    return status === 'rollback_conflict' ? 'conflict' : 'untouched';
  }
}

export const chatmuxBrowserMcpCleanupService = new ChatmuxBrowserMcpCleanupService();

export function applyBrowserMcpCleanup(
  dependencies?: BrowserMcpCleanupDependencies,
): CleanupResult {
  return dependencies
    ? new ChatmuxBrowserMcpCleanupService(dependencies).apply()
    : chatmuxBrowserMcpCleanupService.apply();
}

export function rollbackBrowserMcpCleanup(
  runId: string,
  dependencies?: BrowserMcpCleanupDependencies,
): CleanupResult {
  return dependencies
    ? new ChatmuxBrowserMcpCleanupService(dependencies).rollback(runId)
    : chatmuxBrowserMcpCleanupService.rollback(runId);
}
