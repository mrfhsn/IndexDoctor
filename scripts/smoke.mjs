#!/usr/bin/env node
/**
 * scripts/smoke.mjs — Local and staging smoke test for IndexDoctor.
 * Usage: node scripts/smoke.mjs [baseUrl]
 * Default baseUrl: http://localhost:8080
 */

import { PRESETS } from '../dist/shared/presets/presets.js';

const baseUrl = process.argv[2] || process.env.BASE_URL || 'http://localhost:8080';

console.log(`Starting smoke tests against: ${baseUrl}`);

const results = [];

async function runCheck(name, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    const durationMs = Date.now() - start;
    results.push({ name, status: 'PASS', durationMs, detail: detail || '' });
    console.log(`  ✓ ${name} (${durationMs}ms) ${detail ? `— ${detail}` : ''}`);
  } catch (err) {
    const durationMs = Date.now() - start;
    results.push({ name, status: 'FAIL', durationMs, detail: err.message });
    console.error(`  ✗ ${name} (${durationMs}ms): ${err.message}`);
  }
}

async function main() {
  // 1. Health Live Probe
  await runCheck('GET /api/health/live returns 200', async () => {
    const res = await fetch(`${baseUrl}/api/health/live`);
    if (res.status !== 200) {
      throw new Error(`Expected status 200, got ${res.status}`);
    }
    const body = await res.json();
    if (body.status !== 'ok') {
      throw new Error(`Expected status "ok", got "${body.status}"`);
    }
    return 'status=ok';
  });

  // 2. Health Readiness Probe
  await runCheck('GET /api/health returns 200 and ready', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    if (res.status !== 200) {
      throw new Error(`Expected status 200, got ${res.status}`);
    }
    const body = await res.json();
    if (body.ready !== true) {
      throw new Error(`Expected ready: true, got ${body.ready}`);
    }
    return `ready=true, sandbox=${body.sandbox?.state}`;
  });

  // 3. Security Headers
  await runCheck('Security headers present on /api/health/live', async () => {
    const res = await fetch(`${baseUrl}/api/health/live`);
    const headers = res.headers;

    const nosniff = headers.get('x-content-type-options');
    if (nosniff !== 'nosniff') throw new Error(`Invalid x-content-type-options: ${nosniff}`);

    const referrer = headers.get('referrer-policy');
    if (referrer !== 'no-referrer') throw new Error(`Invalid referrer-policy: ${referrer}`);

    const hsts = headers.get('strict-transport-security');
    if (!hsts || !hsts.includes('max-age'))
      throw new Error(`Missing or invalid strict-transport-security: ${hsts}`);

    const reqId = headers.get('x-request-id');
    if (!reqId) throw new Error('Missing x-request-id header');

    return 'nosniff, referrer, HSTS, request-id verified';
  });

  // 4. Root Endpoint / Static Assets
  await runCheck('GET / serves HTML with 200', async () => {
    const res = await fetch(`${baseUrl}/`);
    if (res.status !== 200) {
      throw new Error(`Expected status 200, got ${res.status}`);
    }
    const text = await res.text();
    if (!text.includes('IndexDoctor')) {
      throw new Error('Expected HTML containing "IndexDoctor"');
    }
    return 'HTML contains IndexDoctor';
  });

  // 5. 3 Golden Presets Execution
  for (const preset of PRESETS) {
    await runCheck(`POST /api/diagnose preset [${preset.id}]`, async () => {
      const res = await fetch(`${baseUrl}/api/diagnose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schema: preset.schema,
          query: preset.query,
          presetId: preset.id,
        }),
      });

      if (res.status !== 200) {
        const errText = await res.text();
        throw new Error(`Expected 200, got ${res.status}: ${errText}`);
      }

      const body = await res.json();
      if (body.outcome !== 'improved') {
        throw new Error(`Expected outcome 'improved', got '${body.outcome}'`);
      }

      const usesIdx = body.plans?.after?.usesIndexes || [];
      const costBefore = body.plans?.before?.cost?.total;
      const costAfter = body.plans?.after?.cost?.total;
      return `outcome=${body.outcome}, verification=${body.verification?.status}, cost: ${costBefore ?? 'n/a'} -> ${costAfter ?? 'n/a'}, uses: [${usesIdx.join(', ')}]`;
    });
  }

  // 6. Hostile Schema & Engine Recovery
  await runCheck('Hostile COPY schema returns 422 & next request recovers', async () => {
    const hostileRes = await fetch(`${baseUrl}/api/diagnose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema: 'COPY accounts FROM STDIN;\n1\tAlice\n\\.',
        query: 'SELECT * FROM accounts;',
      }),
    });

    if (hostileRes.status !== 422) {
      throw new Error(`Expected 422 for hostile COPY statement, got ${hostileRes.status}`);
    }

    // Immediately test that the service is healthy and recovers
    const recoveryRes = await fetch(`${baseUrl}/api/diagnose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema: PRESETS[0].schema,
        query: PRESETS[0].query,
        presetId: PRESETS[0].id,
      }),
    });

    if (recoveryRes.status !== 200) {
      throw new Error(
        `Service failed to recover after hostile input. Status: ${recoveryRes.status}`,
      );
    }

    return 'Hostile 422 rejected; recovery request returned 200';
  });

  // 7. 20 Parallel Requests (Concurrency & Rate Limiting)
  await runCheck('20 Parallel Requests return only 200, 429, or 503', async () => {
    const promises = Array.from({ length: 20 }, async (_, i) => {
      const res = await fetch(`${baseUrl}/api/diagnose`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `198.51.100.${i + 1}`,
        },
        body: JSON.stringify({
          schema: PRESETS[0].schema,
          query: `${PRESETS[0].query} -- parallel test ${i}`,
          presetId: PRESETS[0].id,
        }),
      });
      return res.status;
    });

    const statuses = await Promise.all(promises);
    const validStatuses = new Set([200, 429, 503]);
    const invalid = statuses.filter((s) => !validStatuses.has(s));

    if (invalid.length > 0) {
      throw new Error(`Unexpected HTTP status codes under concurrency: ${invalid.join(', ')}`);
    }

    const counts = statuses.reduce((acc, s) => {
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});

    return `20 requests handled: ${JSON.stringify(counts)}`;
  });

  console.log('\n======================================================');
  console.log('                 SMOKE TEST REPORT                    ');
  console.log('======================================================');
  console.table(
    results.map((r) => ({
      Check: r.name,
      Status: r.status,
      'Time (ms)': r.durationMs,
      Detail: (r.detail || '').slice(0, 60),
    })),
  );

  const hasFailures = results.some((r) => r.status === 'FAIL');
  if (hasFailures) {
    console.error('\n❌ Smoke tests failed!');
    process.exit(1);
  } else {
    console.log('\n✅ All smoke checks passed!');
  }
}

main().catch((err) => {
  console.error('Fatal smoke test runner error:', err);
  process.exit(1);
});
