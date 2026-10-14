#!/usr/bin/env node
/**
 * scripts/smoke.mjs — Local and staging smoke test for IndexDoctor.
 * Usage: node scripts/smoke.mjs [baseUrl]
 * Default baseUrl: http://localhost:8080
 */

const baseUrl = process.argv[2] || process.env.BASE_URL || 'http://localhost:8080';

console.log(`Starting smoke tests against: ${baseUrl}`);

const results = [];

async function runCheck(name, fn) {
  const start = Date.now();
  try {
    await fn();
    const durationMs = Date.now() - start;
    results.push({ name, status: 'PASS', durationMs, error: null });
    console.log(`  ✓ ${name} (${durationMs}ms)`);
  } catch (err) {
    const durationMs = Date.now() - start;
    results.push({ name, status: 'FAIL', durationMs, error: err.message });
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
    if (!body.version) {
      throw new Error('Expected version string');
    }
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
  });

  console.log('\n--- Smoke Test Summary ---');
  console.table(
    results.map((r) => ({ Check: r.name, Status: r.status, 'Time (ms)': r.durationMs })),
  );

  const hasFailures = results.some((r) => r.status === 'FAIL');
  if (hasFailures) {
    console.error('Smoke tests failed!');
    process.exit(1);
  } else {
    console.log('All smoke checks passed!');
  }
}

main().catch((err) => {
  console.error('Fatal smoke test runner error:', err);
  process.exit(1);
});
