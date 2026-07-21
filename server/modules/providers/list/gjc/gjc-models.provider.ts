import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

/**
 * Static model catalog for gjc.
 *
 * gjc does not yet expose a queryable model catalog to ChatMux, so a minimal
 * static fallback is returned. This keeps the model picker functional and can
 * be replaced by a real catalog reader when the source is integrated.
 */
export const GJC_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'default', label: 'Default' },
  ],
  DEFAULT: 'default',
};

export class GjcProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return GJC_FALLBACK_MODELS;
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('gjc', input);
  }
}
