/**
 * Model definitions and capability profiles for the LLM chain.
 * Configured in ADR 0001 and architecture.md §11.2.
 */

type ModelFamily = 'gemini' | 'gemma';

export type ModelProfile = {
  id: string;
  family: ModelFamily;
  structuredOutput: boolean;
  thinkingLevel: 'MINIMAL' | null;
};

/**
 * Default verified chain order from ADR 0001:
 * gemini-3.1-flash-lite -> gemma-4-26b-a4b-it -> gemini-3.5-flash-lite
 */
const DEFAULT_MODEL_PROFILES: Record<string, ModelProfile> = {
  'gemini-3.1-flash-lite': {
    id: 'gemini-3.1-flash-lite',
    family: 'gemini',
    structuredOutput: true,
    thinkingLevel: 'MINIMAL',
  },
  'gemma-4-26b-a4b-it': {
    id: 'gemma-4-26b-a4b-it',
    family: 'gemma',
    structuredOutput: true,
    thinkingLevel: 'MINIMAL',
  },
  'gemma-4-31b-it': {
    id: 'gemma-4-31b-it',
    family: 'gemma',
    structuredOutput: false,
    thinkingLevel: 'MINIMAL',
  },
  'gemini-3.5-flash-lite': {
    id: 'gemini-3.5-flash-lite',
    family: 'gemini',
    structuredOutput: true,
    thinkingLevel: 'MINIMAL',
  },
};

/**
 * Returns the profile for a given model ID, defaulting to standard Gemini capabilities.
 */
export function getModelProfile(modelId: string): ModelProfile {
  const profile = DEFAULT_MODEL_PROFILES[modelId];
  if (profile) {
    return profile;
  }

  const isGemma = modelId.startsWith('gemma');
  return {
    id: modelId,
    family: isGemma ? 'gemma' : 'gemini',
    structuredOutput: !isGemma,
    thinkingLevel: 'MINIMAL',
  };
}
