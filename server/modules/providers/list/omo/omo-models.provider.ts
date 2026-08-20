import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  readLastTranscriptActiveModel,
} from '@/modules/providers/list/omp/omp-models.provider.js';
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
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

const execFileAsync = promisify(execFile);

const OMO_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [{ value: 'default', label: 'Current CLI model' }],
  DEFAULT: 'default',
};

/**
 * `omo --list-models` prints an aligned text table, not JSON:
 *
 *   provider            model            context  max-out  thinking  images
 *   alibaba-token-plan  deepseek-v3.2    131.1K   65.5K    yes       no
 *
 * Every column is whitespace-free, so a row is exactly six tokens. Requiring
 * that shape plus yes/no flags rejects the header and any startup chatter the
 * CLI writes before the table.
 */
export function parseOmoModelCatalog(raw: string): ProviderModelsDefinition {
  const options: ProviderModelOption[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length !== 6) continue;
    const [provider, model, context, , thinking, images] = columns;
    if (!/^(?:yes|no)$/i.test(thinking) || !/^(?:yes|no)$/i.test(images)) continue;
    const selector = `${provider}/${model}`;
    if (seen.has(selector)) continue;
    seen.add(selector);
    options.push({
      value: selector,
      label: model,
      description: `${context} context · ${provider}`,
    });
  }
  return options.length > 0
    ? { OPTIONS: [...OMO_FALLBACK_MODELS.OPTIONS, ...options], DEFAULT: OMO_FALLBACK_MODELS.DEFAULT }
    : OMO_FALLBACK_MODELS;
}

async function loadOmoModelCatalog(): Promise<ProviderModelsDefinition> {
  try {
    const { stdout } = await execFileAsync(
      'omo',
      ['--list-models'],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return parseOmoModelCatalog(stdout);
  } catch {
    return OMO_FALLBACK_MODELS;
  }
}

export class OmoProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return loadOmoModelCatalog();
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    const row = sessionId ? sessionsDb.getSessionById(sessionId) : null;
    if (row?.jsonl_path) {
      const activeModel = await readLastTranscriptActiveModel(row.jsonl_path).catch(() => null);
      if (activeModel) return activeModel;
    }
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('omo', input);
  }
}
