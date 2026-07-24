import { open, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import TOML from '@iarna/toml';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

export const CODEX_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'gpt-5.5',
      label: 'gpt-5.5',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4',
      label: 'gpt-5.4',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4-mini',
      label: 'gpt-5.4-mini',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
  ],
  DEFAULT: 'gpt-5.4',
};

type CodexCachedModel = {
  slug?: string;
  display_name?: string;
  description?: string;
  priority?: number;
  visibility?: string;
  supported_in_api?: boolean;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{
    effort?: string;
    description?: string;
  }>;
};

const CODEX_MODELS_CACHE_PATH = path.join(os.homedir(), '.codex', 'models_cache.json');
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

const CODEX_MODEL_SCAN_CHUNK_BYTES = 256 * 1024;

type CodexModelCacheEntry = {
  size: number;
  activeModel: ProviderCurrentActiveModel | null;
};

const codexSessionModelCache = new Map<string, CodexModelCacheEntry>();

export const parseCodexTurnActiveModel = (line: string): ProviderCurrentActiveModel | null => {
  try {
    const event = readObjectRecord(JSON.parse(line));
    if (event?.type !== 'turn_context') {
      return null;
    }
    const payload = readObjectRecord(event.payload);
    const model = readOptionalString(payload?.model);
    if (!model) {
      return null;
    }
    const effort = readOptionalString(payload?.effort)
      ?? readOptionalString(payload?.reasoning_effort);
    return {
      model,
      ...(effort ? { effort } : {}),
    };
  } catch {
    return null;
  }
};

/**
 * Incrementally scans an append-only Codex rollout for the latest turn model.
 * Completed JSONL files are cached by byte size, so the five-second live-session
 * poll reads only newly appended bytes instead of repeatedly loading a large
 * transcript.
 */
export const readCodexSessionModelFromJsonl = async (
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const handle = await open(jsonlPath, 'r');
  try {
    const { size } = await handle.stat();
    const cached = codexSessionModelCache.get(jsonlPath);
    if (cached?.size === size) {
      return cached.activeModel;
    }

    const canResume = Boolean(cached && cached.size < size);
    let cursor = canResume ? (cached?.size ?? 0) : 0;
    let activeModel = canResume ? (cached?.activeModel ?? null) : null;
    let remainder = '';
    const decoder = new StringDecoder('utf8');

    while (cursor < size) {
      const length = Math.min(CODEX_MODEL_SCAN_CHUNK_BYTES, size - cursor);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, cursor);
      if (bytesRead === 0) {
        break;
      }
      cursor += bytesRead;

      const lines = `${remainder}${decoder.write(buffer.subarray(0, bytesRead))}`.split(/\r?\n/);
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        const nextActiveModel = parseCodexTurnActiveModel(line);
        if (nextActiveModel) {
          activeModel = nextActiveModel;
        }
      }
    }

    remainder += decoder.end();
    const trailingActiveModel = remainder ? parseCodexTurnActiveModel(remainder) : null;
    if (trailingActiveModel) {
      activeModel = trailingActiveModel;
    }

    // Only cache a newline-terminated byte boundary. If Codex is mid-write, the
    // next poll must rescan from the last known complete boundary.
    if (!remainder) {
      codexSessionModelCache.set(jsonlPath, { size, activeModel });
    }
    return activeModel;
  } finally {
    await handle.close();
  }
};

const isCodexCachedModel = (value: unknown): value is CodexCachedModel => {
  const record = readObjectRecord(value);
  return Boolean(record && readOptionalString(record.slug));
};

const readCodexPriority = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
);

const mapCodexModel = (model: CodexCachedModel): ProviderModelOption => {
  const effortValues = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
      .map((level) => {
        const value = readOptionalString(level?.effort);
        if (!value) {
          return null;
        }

        return {
          value,
          description: readOptionalString(level?.description),
        };
      })
      .filter((level): level is NonNullable<typeof level> => Boolean(level))
    : [];

  return {
    value: model.slug as string,
    label: readOptionalString(model.display_name) ?? (model.slug as string),
    description: readOptionalString(model.description),
    effort: effortValues.length > 0
      ? {
          default: readOptionalString(model.default_reasoning_level) ?? undefined,
          values: effortValues,
        }
      : undefined,
  };
};

const buildCodexModelsDefinition = (models: CodexCachedModel[]): ProviderModelsDefinition => {
  const sortedModels = [...models]
    .filter((model) => model.visibility === 'list' && model.supported_in_api !== false)
    .sort((left, right) => readCodexPriority(left.priority) - readCodexPriority(right.priority));

  const options: ProviderModelOption[] = [];
  const seenValues = new Set<string>();

  for (const model of sortedModels) {
    const mappedModel = mapCodexModel(model);
    if (seenValues.has(mappedModel.value)) {
      continue;
    }

    seenValues.add(mappedModel.value);
    options.push(mappedModel);
  }

  if (options.length === 0) {
    return CODEX_FALLBACK_MODELS;
  }

  return {
    OPTIONS: options,
    DEFAULT: options[0]?.value ?? CODEX_FALLBACK_MODELS.DEFAULT,
  };
};

export class CodexProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const raw = await readFile(CODEX_MODELS_CACHE_PATH, 'utf8');
      const parsed = readObjectRecord(JSON.parse(raw));
      const models = Array.isArray(parsed?.models)
        ? parsed.models.filter(isCodexCachedModel)
        : [];

      return buildCodexModelsDefinition(models);
    } catch {
      return CODEX_FALLBACK_MODELS;
    }
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (sessionId?.trim()) {
      try {
        const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
        const activeModel = jsonlPath
          ? await readCodexSessionModelFromJsonl(jsonlPath)
          : null;
        if (activeModel?.model) {
          return activeModel;
        }
      } catch {
        // Fall through to the Codex config/default when transcript lookup fails.
      }
    }

    try {
      const raw = await readFile(CODEX_CONFIG_PATH, 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      const effort = readOptionalString(parsed?.model_reasoning_effort);
      if (model) {
        return {
          model,
          ...(effort ? { effort } : {}),
        };
      }
    } catch {
      // Fall through to the supported-model default.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('codex', input);
  }
}
