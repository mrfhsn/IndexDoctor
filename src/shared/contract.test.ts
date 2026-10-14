import { describe, it, expect } from 'vitest';

import {
  diagnoseRequestSchema,
  errorEnvelopeSchema,
  healthResponseSchema,
  type DiagnoseRequest,
} from './contract.js';

describe('Shared Contract Schemas', () => {
  it('validates a valid DiagnoseRequest', () => {
    const valid: DiagnoseRequest = {
      schema: 'CREATE TABLE users (id int);',
      query: 'SELECT * FROM users;',
      presetId: 'orders-composite',
    };

    const parsed = diagnoseRequestSchema.parse(valid);
    expect(parsed.schema).toBe(valid.schema);
    expect(parsed.query).toBe(valid.query);
    expect(parsed.presetId).toBe(valid.presetId);
  });

  it('rejects unknown properties in DiagnoseRequest (strict)', () => {
    const invalid = {
      schema: 'CREATE TABLE users (id int);',
      query: 'SELECT * FROM users;',
      extraField: 'not allowed',
    };

    expect(() => diagnoseRequestSchema.parse(invalid)).toThrow();
  });

  it('validates standard ErrorEnvelope', () => {
    const envelope = {
      error: {
        code: 'UNSUPPORTED_SQL',
        message: 'Invalid AST node',
        hint: 'Use simple SELECT statement',
      },
      requestId: 'req-123',
    };

    const parsed = errorEnvelopeSchema.parse(envelope);
    expect(parsed.error.code).toBe('UNSUPPORTED_SQL');
    expect(parsed.requestId).toBe('req-123');
  });

  it('validates standard HealthResponse', () => {
    const health = {
      ready: true,
      version: '0.1.0',
      uptimeSec: 42,
      sandbox: {
        state: 'ready',
        respawns: 0,
        jobsSinceSpawn: 10,
      },
      llm: {
        configured: true,
        models: [{ id: 'gemini-3.1-flash-lite', breaker: 'closed' }],
      },
    };

    const parsed = healthResponseSchema.parse(health);
    expect(parsed.ready).toBe(true);
    expect(parsed.version).toBe('0.1.0');
  });
});
