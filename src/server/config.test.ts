import fs from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import { parseConfig, CONFIG_KEYS } from './config.js';

describe('Server Configuration', () => {
  it('parses defaults when no environment variables are provided', () => {
    const config = parseConfig({});
    expect(config.PORT).toBe(8080);
    expect(config.NODE_ENV).toBe('production');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.LLM_THINKING_LEVEL).toBe('minimal');
    expect(config.REQUEST_DEADLINE_MS).toBe(30000);
    expect(config.MAX_IN_FLIGHT).toBe(24);
  });

  it('parses valid custom environment variables', () => {
    const config = parseConfig({
      PORT: '9000',
      NODE_ENV: 'development',
      LOG_LEVEL: 'debug',
      GEMINI_API_KEY: 'test-key',
      LLM_MODELS: 'custom-model-1,custom-model-2',
      MAX_IN_FLIGHT: '10',
    });

    expect(config.PORT).toBe(9000);
    expect(config.NODE_ENV).toBe('development');
    expect(config.LOG_LEVEL).toBe('debug');
    expect(config.GEMINI_API_KEY).toBe('test-key');
    expect(config.LLM_MODELS).toBe('custom-model-1,custom-model-2');
    expect(config.MAX_IN_FLIGHT).toBe(10);
  });

  it('fails fast with readable error when an environment variable is invalid', () => {
    expect(() => {
      parseConfig({
        PORT: 'invalid-port',
      });
    }).toThrow(/Configuration initialization error/);
  });

  it('enforces perfect sync between .env.example and config.ts keys', () => {
    const envExamplePath = path.resolve(process.cwd(), '.env.example');
    const content = fs.readFileSync(envExamplePath, 'utf8');
    const exampleKeys = content
      .split('\n')
      .map((l: string) => l.trim())
      .filter((l: string) => l && !l.startsWith('#'))
      .map((l: string) => l.split('=')[0]?.trim())
      .filter((k: string | undefined): k is string => Boolean(k));

    const configKeys = [...CONFIG_KEYS];

    // Every key in .env.example must be present in config
    for (const key of exampleKeys) {
      expect(configKeys).toContain(key);
    }

    // Every key in config must be present in .env.example
    for (const key of configKeys) {
      expect(exampleKeys).toContain(key);
    }
  });
});
