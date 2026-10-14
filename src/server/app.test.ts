import { describe, it, expect } from 'vitest';

import {
  healthLiveResponseSchema,
  healthResponseSchema,
  errorEnvelopeSchema,
} from '../shared/contract.js';
import { createApp } from './app.js';
import { parseConfig } from './config.js';

describe('HTTP Application & Security (Gate 1)', () => {
  const config = parseConfig({
    GEMINI_API_KEY: 'test-api-key',
  });
  const app = createApp({ config });

  it('GET /api/health/live returns 200 and matches HealthLiveResponse schema (I6)', async () => {
    const res = await app.request('/api/health/live');
    expect(res.status).toBe(200);

    const body = await res.json();
    const parsed = healthLiveResponseSchema.parse(body);
    expect(parsed.status).toBe('ok');
  });

  it('GET /api/health returns 200 and matches HealthResponse schema', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);

    const body = await res.json();
    const parsed = healthResponseSchema.parse(body);
    expect(parsed.ready).toBe(true);
    expect(parsed.version).toBe('0.1.0');
    expect(parsed.sandbox.state).toBe('not_started');
    expect(parsed.llm.configured).toBe(true);
    expect(parsed.llm.models.length).toBeGreaterThan(0);
  });

  it('includes required security headers on all responses', async () => {
    const res = await app.request('/api/health/live');

    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('enforces in-flight limit and returns 503 BUSY with error envelope', async () => {
    const lowCapConfig = parseConfig({
      MAX_IN_FLIGHT: '0', // Immediate rejection
    });
    const lowCapApp = createApp({ config: lowCapConfig });

    const res = await lowCapApp.request('/api/health/live');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('2');

    const body = await res.json();
    const parsed = errorEnvelopeSchema.parse(body);
    expect(parsed.error.code).toBe('BUSY');
    expect(parsed.requestId).toBeTruthy();
  });
});
