import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import type { RuntimeCapabilities } from '../../../shared/terminal-runtime.js';

import type { HerdrSourceId } from './herdr-internal.types.js';

export const HERDR_RUNTIME_ENV = 'CHATMUX_HERDR_RUNTIME';
export const HERDR_SOURCES_ENV = 'CHATMUX_HERDR_SOURCES';
export const HERDR_CAPABILITIES_ENV = 'CHATMUX_HERDR_CAPABILITIES';
export const HERDR_POLICY_FILE_ENV = 'CHATMUX_HERDR_POLICY_FILE';
export const HERDR_MAX_SOURCES = 8;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SELECTOR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CAPABILITIES = ['discovery', 'output', 'actions', 'attach'] as const;
export type HerdrConfiguredSource = { alias: string; sourceId: HerdrSourceId; selector: string; binary: string };
export type HerdrRuntimeConfig = { enabled: boolean; sources: readonly HerdrConfiguredSource[]; startupCapabilities: RuntimeCapabilities; policyPath: string | null; errorCode: string | null };

function disabled(errorCode: string | null): HerdrRuntimeConfig {
  return { enabled: false, sources: [], startupCapabilities: { discovery: false, output: false, actions: false, attach: false, create: false }, policyPath: null, errorCode };
}
export function herdrSourceId(alias: string): HerdrSourceId {
  return `hsrc_${createHash('sha256').update(alias, 'utf8').digest().subarray(0, 16).toString('base64url')}`;
}
function parseCapabilities(raw: string | undefined): RuntimeCapabilities | null {
  const result: Record<'discovery' | 'output' | 'actions' | 'attach' | 'create', boolean> = { discovery: false, output: false, actions: false, attach: false, create: false };
  if (!raw) return result;
  const values = raw.split(',');
  if (values.some((value) => !CAPABILITIES.includes(value as typeof CAPABILITIES[number])) || new Set(values).size !== values.length) return null;
  for (const value of values) result[value as typeof CAPABILITIES[number]] = true;
  return result;
}
export function readHerdrRuntimeConfig(env: NodeJS.ProcessEnv = process.env, platform = process.platform, arch = process.arch): HerdrRuntimeConfig {
  if (env[HERDR_RUNTIME_ENV] !== '1') return disabled(null);
  if (platform !== 'linux' || arch !== 'x64') return disabled('platform_unsupported');
  const capabilities = parseCapabilities(env[HERDR_CAPABILITIES_ENV]);
  if (!capabilities) return disabled('invalid_capabilities');
  const policyPath = env[HERDR_POLICY_FILE_ENV];
  if (policyPath !== undefined && (!isAbsolute(policyPath) || policyPath.includes('\0') || policyPath.length > 4096)) return disabled('invalid_policy_path');
  const raw = env[HERDR_SOURCES_ENV];
  if (!raw || raw.length > 16 * 1024) return disabled('invalid_sources');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return disabled('invalid_sources'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > HERDR_MAX_SOURCES) return disabled('invalid_sources');
  const aliases = new Set<string>();
  const sources: HerdrConfiguredSource[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return disabled('invalid_sources');
    const value = entry as { alias?: unknown; selector?: unknown; binary?: unknown };
    if (Object.keys(value).length !== 3 || !['alias', 'selector', 'binary'].every((key) => Object.prototype.hasOwnProperty.call(value, key)) || typeof value.alias !== 'string' || !ALIAS_RE.test(value.alias) || aliases.has(value.alias) || typeof value.selector !== 'string' || !SELECTOR_RE.test(value.selector) || value.selector === 'default' || typeof value.binary !== 'string' || !isAbsolute(value.binary) || value.binary.includes('\0') || value.binary.length > 4096) return disabled('invalid_sources');
    aliases.add(value.alias);
    sources.push({ alias: value.alias, sourceId: herdrSourceId(value.alias), selector: value.selector, binary: value.binary });
  }
  return { enabled: true, sources, startupCapabilities: capabilities, policyPath: policyPath ?? null, errorCode: null };
}
