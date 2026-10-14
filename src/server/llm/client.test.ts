import { describe, expect, it } from 'vitest';

import { LlmClient, type GenerateContentFn } from './client.js';
import type { BuiltPrompt } from './prompt.js';

describe('llm/client', () => {
  const dummyPrompt: BuiltPrompt = {
    systemInstruction: 'You are an index advisor.',
    userPrompt: '=== QUERY ===\nSELECT * FROM orders WHERE customer_id = 1;',
  };

  it('generates content successfully using generator', async () => {
    const generator: GenerateContentFn = async (modelId, contents, config) => {
      expect(modelId).toBe('gemini-3.1-flash-lite');
      expect(contents).toBe(dummyPrompt.userPrompt);
      expect(config['responseMimeType']).toBe('application/json');
      return { text: '{"headline": "test"}' };
    };

    const client = new LlmClient({ generator });
    const res = await client.generate('gemini-3.1-flash-lite', dummyPrompt);

    expect(res.text).toBe('{"headline": "test"}');
    expect(res.ms).toBeGreaterThanOrEqual(0);
  });

  it('progresses through capability downgrade ladder on HTTP 400', async () => {
    let callCount = 0;
    const configsUsed: Record<string, unknown>[] = [];

    const generator: GenerateContentFn = async (_model, _contents, config) => {
      callCount += 1;
      configsUsed.push(config);
      if (callCount === 1) {
        // Level 0 fails with 400 (thinking not supported)
        const err = Object.assign(new Error('HTTP 400: thinking not supported'), { status: 400 });
        throw err;
      }
      if (callCount === 2) {
        // Level 1 fails with 400 (schema not supported)
        const err = Object.assign(new Error('HTTP 400: schema not supported'), { status: 400 });
        throw err;
      }
      // Level 2 succeeds
      return { text: '{"headline": "downgraded_success"}' };
    };

    const client = new LlmClient({ generator });
    expect(client.getDowngradeLevel('model-test')).toBe(0);

    const res = await client.generate('model-test', dummyPrompt);

    expect(res.text).toBe('{"headline": "downgraded_success"}');
    expect(callCount).toBe(3);
    expect(client.getDowngradeLevel('model-test')).toBe(2);

    // Verify configs:
    // Level 0 had thinkingConfig
    expect(configsUsed[0]?.['thinkingConfig']).toBeDefined();
    // Level 1 dropped thinkingConfig but kept responseSchema
    expect(configsUsed[1]?.['thinkingConfig']).toBeUndefined();
    expect(configsUsed[1]?.['responseSchema']).toBeDefined();
    // Level 2 dropped responseSchema
    expect(configsUsed[2]?.['responseSchema']).toBeUndefined();
  });

  it('formats repair turn correctly as user-model-user multi-turn sequence', async () => {
    let receivedContents: unknown;

    const generator: GenerateContentFn = async (_model, contents) => {
      receivedContents = contents;
      return { text: '{"headline": "repaired"}' };
    };

    const client = new LlmClient({ generator });
    await client.generate('gemini-3.1-flash-lite', dummyPrompt, {
      repairTurn: {
        previousOutput: '{"headline": 123}',
        error: 'headline must be a string',
      },
    });

    expect(Array.isArray(receivedContents)).toBe(true);
    if (!Array.isArray(receivedContents)) return;
    expect(receivedContents).toHaveLength(3);

    const first = receivedContents[0];
    const second = receivedContents[1];
    const third = receivedContents[2];

    expect(
      typeof first === 'object' && first !== null && 'role' in first && first.role === 'user',
    ).toBe(true);
    expect(
      typeof second === 'object' && second !== null && 'role' in second && second.role === 'model',
    ).toBe(true);
    expect(
      typeof third === 'object' && third !== null && 'role' in third && third.role === 'user',
    ).toBe(true);
  });
});
