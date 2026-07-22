import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

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

const execFileAsync = promisify(execFile);

export function parseOmpModelCatalog(raw: string): ProviderModelsDefinition {
  const payload = readObjectRecord(JSON.parse(raw));
  const rows = Array.isArray(payload?.models) ? payload.models : [];
  const options: ProviderModelOption[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const model = readObjectRecord(row);
    const selector = readOptionalString(model?.selector);
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    const label = readOptionalString(model?.name) ?? selector;
    const contextWindow = typeof model?.contextWindow === 'number'
      ? model.contextWindow
      : null;
    const thinking = Array.isArray(model?.thinking)
      ? model.thinking.filter((value): value is string => typeof value === 'string')
      : [];
    options.push({
      value: selector,
      label,
      ...(contextWindow ? { description: `${contextWindow.toLocaleString()} token context` } : {}),
      ...(thinking.length > 0
        ? {
            effort: {
              values: thinking.map((value) => ({ value })),
            },
          }
        : {}),
    });
  }
  return {
    OPTIONS: [...OMP_FALLBACK_MODELS.OPTIONS, ...options],
    DEFAULT: OMP_FALLBACK_MODELS.DEFAULT,
  };
}

async function loadOmpModelCatalog(): Promise<ProviderModelsDefinition> {
  try {
    const { stdout } = await execFileAsync(
      'omp',
      ['models', '--json', '--no-extensions'],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return parseOmpModelCatalog(stdout);
  } catch {
    return OMP_FALLBACK_MODELS;
  }
}

const OMP_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [{ value: 'default', label: 'Current CLI model' }],
  DEFAULT: 'default',
};

async function readLastTranscriptModel(filePath: string): Promise<string | null> {
  let model: string | null = null;
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line.includes('"model"')) continue;
      try {
        const entry = readObjectRecord(JSON.parse(line));
        const entryModel = readOptionalString(entry?.model)
          ?? readOptionalString(readObjectRecord(entry?.message)?.model);
        if (entryModel) model = entryModel;
      } catch {
        // A partially written tail line is retried by the next poll.
      }
    }
  } finally {
    lines.close();
  }
  return model;
}

export class OmpProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return loadOmpModelCatalog();
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    const row = sessionId ? sessionsDb.getSessionById(sessionId) : null;
    if (row?.jsonl_path) {
      const model = await readLastTranscriptModel(row.jsonl_path).catch(() => null);
      if (model) return { model };
    }
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('omp', input);
  }
}
