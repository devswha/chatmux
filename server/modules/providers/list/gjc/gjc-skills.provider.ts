import os from 'node:os';
import path from 'node:path';

import { probeNativeSkillCatalog } from '@/modules/providers/shared/skills/native-skill-probe.js';
import type { NativeSkillProbeEntry } from '@/modules/providers/shared/skills/native-skill-probe.js';
import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type {
  ProviderSkill,
  ProviderSkillListOptions,
  ProviderSkillScope,
  ProviderSkillSource,
} from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  findProviderSkillMarkdownFiles,
  readProviderSkillMarkdownDefinition,
} from '@/shared/utils.js';

/**
 * Native GJC skill inventory adapter.
 *
 * The installed `gjc` CLI exposes two machine-readable inventories that this
 * adapter unions with GJC's own precedence rules:
 *   - `gjc skills list --json`: the bundled workflow skills the CLI ships with,
 *     returned with synthetic `embedded:gjc/skills/<name>/SKILL.md` paths.
 *   - `gjc skills discover --json`: the effective filesystem candidates the CLI
 *     would actually load, with the bundled/higher-precedence shadowing already
 *     applied by the CLI. Discovered entries carry real filesystem paths and a
 *     `user`/`project` source tag.
 *
 * Both inventories are invoked exclusively through the bounded native probe:
 * argv-based (no shell), 4-second timeout, per-stream 1 MiB cap, and 500
 * normalized entries. Probe failures never surface another provider's catalog;
 * when the discovered inventory cannot be parsed the adapter falls back to a
 * safe filesystem scan of GJC's own documented skill roots so a locally
 * authored `.gjc/skills` entry stays visible without any foreign import.
 *
 * Native shadowing rule: a bundled entry always wins a same-name collision
 * against a discovered candidate, matching how the CLI itself reports the
 * shadow diagnostics. Within the discovered tier, the probe's alphabetical
 * order with native-precedence tie-break decides the winner; ties fall back to
 * the filesystem-scan order (project before user).
 */
export class GjcSkillsProvider extends SkillsProvider {
  constructor() {
    super('gjc');
  }

  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const workspacePath = path.resolve(options?.workspacePath ?? process.cwd());

    // Probe both inventories concurrently: the CLI itself is read-only and
    // idempotent, and the shared single-flight cache dedupes identical calls
    // if a peer subsystem asks for the same provider/workspace at the same
    // instant.
    const [bundledResult, discoveredResult] = await Promise.all([
      probeNativeSkillCatalog({
        provider: 'gjc',
        workspacePath,
        command: GJC_COMMAND,
        args: [...GJC_LIST_ARGS],
      }),
      probeNativeSkillCatalog({
        provider: 'gjc',
        workspacePath,
        command: GJC_COMMAND,
        args: [...GJC_DISCOVER_ARGS],
      }),
    ]);

    const skills: ProviderSkill[] = [];
    const seenCommands = new Set<string>();

    // Bundled tier first so it wins native shadowing on same-name collisions.
    if (bundledResult.ok) {
      for (const entry of bundledResult.entries) {
        if (!isActiveNativeEntry(entry)) {
          continue;
        }
        const skill = this.toBundledSkill(entry);
        if (seenCommands.has(skill.command)) {
          continue;
        }
        seenCommands.add(skill.command);
        skills.push(skill);
      }
    }

    // Discovered tier next. If the native inventory cannot be parsed we fall
    // back to a bounded filesystem scan of GJC's own documented skill roots -
    // never another provider's directory - so the catalog degrades gracefully
    // rather than substituting foreign skills.
    if (discoveredResult.ok) {
      for (const entry of discoveredResult.entries) {
        if (!isActiveNativeEntry(entry)) {
          continue;
        }
        const skill = this.toDiscoveredSkill(entry);
        if (skill === null || seenCommands.has(skill.command)) {
          continue;
        }
        seenCommands.add(skill.command);
        skills.push(skill);
      }
    } else {
      for (const skill of await this.readFilesystemFallback(workspacePath)) {
        if (seenCommands.has(skill.command)) {
          continue;
        }
        seenCommands.add(skill.command);
        skills.push(skill);
      }
    }

    return skills;
  }

  /**
   * The shared filesystem-source scanner is unused for GJC because the native
   * probe is the primary inventory contract. An empty source list keeps the
   * base class's read path a no-op if it is ever invoked directly.
   */
  protected async getSkillSources(): Promise<ProviderSkillSource[]> {
    return [];
  }

  /**
   * Normalizes one `gjc skills list --json` record into a `ProviderSkill`.
   *
   * The CLI reports bundled workflow skills with `embedded:gjc/skills/...` as
   * a truthful synthetic path - the skill body lives inside the compiled CLI,
   * not on disk. That marker is preserved verbatim so downstream consumers can
   * distinguish a bundled entry from a filesystem candidate.
   */
  private toBundledSkill(entry: NativeSkillProbeEntry): ProviderSkill {
    return {
      provider: 'gjc',
      name: entry.name,
      description: entry.description,
      command: `/${entry.name}`,
      scope: 'system',
      sourcePath: entry.sourcePath ?? `embedded:gjc/skills/${entry.name}/SKILL.md`,
    };
  }

  /**
   * Normalizes one `gjc skills discover --json` candidate.
   *
   * Candidates without a truthful filesystem path are dropped, matching the
   * plan's contract that every returned entry must attribute a real markdown
   * source instead of a fabricated location.
   */
  private toDiscoveredSkill(entry: NativeSkillProbeEntry): ProviderSkill | null {
    if (entry.sourcePath === null) {
      return null;
    }
    return {
      provider: 'gjc',
      name: entry.name,
      description: entry.description,
      command: `/${entry.name}`,
      scope: mapDiscoveredScope(entry.source),
      sourcePath: entry.sourcePath,
    };
  }

  /**
   * Safe filesystem fallback used when the native discover probe fails.
   *
   * Scans only GJC's own project and user skill roots. `.codex`, `.claude`,
   * `.agents`, `.omp`, and every other coding agent's directory is out of
   * contract for GJC and is never consulted here.
   */
  private async readFilesystemFallback(workspacePath: string): Promise<ProviderSkill[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'project',
      rootDir: path.join(workspacePath, '.gjc', 'skills'),
      commandPrefix: '/',
    });

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.gjc', 'agent', 'skills'),
      commandPrefix: '/',
    });

    const skills: ProviderSkill[] = [];
    for (const source of sources) {
      const skillFiles = await findProviderSkillMarkdownFiles(source.rootDir);
      for (const skillPath of skillFiles) {
        try {
          const definition = await readProviderSkillMarkdownDefinition(skillPath);
          skills.push({
            provider: 'gjc',
            name: definition.name,
            description: definition.description,
            command: `/${definition.name}`,
            scope: source.scope,
            sourcePath: skillPath,
          });
        } catch {
          // A malformed or unreadable skill markdown file must never hide a
          // valid sibling skill, matching the shared scanner's contract.
        }
      }
    }
    return skills;
  }
}

const GJC_COMMAND = 'gjc';
const GJC_LIST_ARGS = ['skills', 'list', '--json'] as const;
const GJC_DISCOVER_ARGS = ['skills', 'discover', '--json'] as const;

/**
 * Native shadow filter: a probe entry counts as active only when the CLI marks
 * it enabled and it has not already been shadowed by a higher-precedence
 * source. This matches how `gjc skills discover` folds shadow relationships
 * into diagnostics instead of surfacing the loser.
 */
const isActiveNativeEntry = (entry: NativeSkillProbeEntry): boolean => (
  entry.enabled && entry.shadowedBy === null
);

/**
 * Maps the CLI's `source` tag to the ProviderSkillScope union.
 *
 * The native `discover --json` output tags each candidate as `user` or
 * `project`. Unknown or missing tags fall back to `user`, which is the widest
 * documented candidate scope and never masquerades as a bundled/system entry.
 */
const mapDiscoveredScope = (source: string | null): ProviderSkillScope => {
  if (source === 'project') {
    return 'project';
  }
  return 'user';
};
