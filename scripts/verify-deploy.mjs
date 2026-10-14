#!/usr/bin/env node
/**
 * scripts/verify-deploy.mjs — Cloud Run deployment verification gate.
 * Rule 20 & Gate 1/6 acceptance: Never report healthy without this script exiting 0.
 *
 * Usage: node scripts/verify-deploy.mjs [--skeleton] [service-name] [region]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { PRESETS } from '../dist/shared/presets/presets.js';

const isSkeleton = process.argv.includes('--skeleton') || process.env.GATE === '1';
const filteredArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const serviceName = filteredArgs[0] || 'indexdoctor';
const region = filteredArgs[1] || 'us-central1';

console.log(`\n======================================================`);
console.log(`  IndexDoctor Deploy Verification (${isSkeleton ? 'Gate 1 Skeleton' : 'Full Suite'})`);
console.log(`  Service: ${serviceName} | Region: ${region}`);
console.log(`======================================================\n`);

// Locate gcloud executable
function getGcloudCmd() {
  const customPath = path.join(
    process.env.LOCALAPPDATA || 'C:\\Users\\mrfhs\\AppData\\Local',
    'Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd',
  );
  if (fs.existsSync(customPath)) {
    return `"${customPath}"`;
  }
  return 'gcloud';
}

const gcloud = getGcloudCmd();

const results = [];

async function step(name, fn) {
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
  let serviceDesc = null;
  let serviceUrl = null;

  // 1. Describe Cloud Run service
  await step('Cloud Run describe & Revision Health', () => {
    const output = execFileSync(
      gcloud,
      ['run', 'services', 'describe', serviceName, '--region', region, '--format', 'json'],
      { encoding: 'utf8', shell: true },
    );
    serviceDesc = JSON.parse(output);

    const latestCreated = serviceDesc.status?.latestCreatedRevisionName;
    const latestReady = serviceDesc.status?.latestReadyRevisionName;

    if (!latestReady) throw new Error('Service has no ready revision');
    if (latestCreated !== latestReady) {
      throw new Error(`Revision mismatch: created=${latestCreated}, ready=${latestReady}`);
    }

    // Traffic check
    const traffic = serviceDesc.status?.traffic || [];
    const is100Ready = traffic.some(
      (t) => (t.revisionName === latestReady || t.percent === 100) && t.percent === 100,
    );
    if (!is100Ready) {
      throw new Error(`Traffic is not 100% to ready revision: ${JSON.stringify(traffic)}`);
    }

    serviceUrl = serviceDesc.status?.url;
    if (!serviceUrl) throw new Error('Service URL not found in service status');

    return `URL: ${serviceUrl}, Rev: ${latestReady}`;
  });

  if (!serviceDesc) {
    console.error('\nFatal: Could not retrieve Cloud Run service description.');
    process.exit(1);
  }

  // 2. Verify Architecture Spec Configuration
  await step('Cloud Run Resource & Scaling Specs', () => {
    const template = serviceDesc.spec?.template;
    const annotations = template?.metadata?.annotations || {};
    const container = template?.spec?.containers?.[0];

    const resources = container?.resources?.limits || {};
    const memory = resources.memory;
    const cpu = resources.cpu;

    if (memory !== '2Gi' && memory !== '2048Mi') {
      throw new Error(`Expected memory 2Gi, got: ${memory}`);
    }
    if (String(cpu) !== '1') {
      throw new Error(`Expected cpu 1, got: ${cpu}`);
    }

    const minInstances = annotations['autoscaling.knative.dev/minScale'];
    const maxInstances = annotations['autoscaling.knative.dev/maxScale'];
    if (minInstances !== '1') {
      throw new Error(`Expected minScale '1', got: ${minInstances}`);
    }
    if (maxInstances !== '5') {
      throw new Error(`Expected maxScale '5', got: ${maxInstances}`);
    }

    const concurrency = template?.spec?.containerConcurrency;
    if (concurrency !== 8) {
      throw new Error(`Expected containerConcurrency 8, got: ${concurrency}`);
    }

    const cpuThrottling = annotations['run.googleapis.com/cpu-throttling'];
    if (cpuThrottling !== 'false') {
      throw new Error(`Expected cpu-throttling 'false' (always-on), got: ${cpuThrottling}`);
    }

    const cpuBoost = annotations['run.googleapis.com/startup-cpu-boost'];
    if (cpuBoost !== 'true') {
      throw new Error(`Expected startup-cpu-boost 'true', got: ${cpuBoost}`);
    }

    // Check GEMINI_API_KEY secret binding
    const envVars = container?.env || [];
    const secretEnv = envVars.find((e) => e.name === 'GEMINI_API_KEY');
    if (!secretEnv || !secretEnv.valueFrom?.secretKeyRef) {
      throw new Error('GEMINI_API_KEY is not bound from Secret Manager');
    }

    return `2Gi, 1 vCPU, min=1, max=5, conc=8, cpu-boost=true, secret bound`;
  });

  // 3. Health Live Probe
  await step('Public GET /api/health/live', async () => {
    const res = await fetch(`${serviceUrl}/api/health/live`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(`Unexpected body: ${JSON.stringify(data)}`);
    return 'HTTP 200 status=ok';
  });

  // 4. Health Readiness / Startup Probe
  await step('Public GET /api/health', async () => {
    const res = await fetch(`${serviceUrl}/api/health`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ready !== true) throw new Error(`Service not ready: ${JSON.stringify(data)}`);
    if (data.llm?.configured !== true) throw new Error('LLM is not configured on live service');
    return `HTTP 200 ready=true, llm.configured=true, sandbox=${data.sandbox?.state}`;
  });

  // 5. Security Headers
  await step('Public Security Headers', async () => {
    const res = await fetch(`${serviceUrl}/api/health/live`);
    const headers = res.headers;

    const nosniff = headers.get('x-content-type-options');
    if (nosniff !== 'nosniff') throw new Error(`Missing x-content-type-options: ${nosniff}`);

    const referrer = headers.get('referrer-policy');
    if (referrer !== 'no-referrer') throw new Error(`Missing referrer-policy: ${referrer}`);

    const hsts = headers.get('strict-transport-security');
    if (!hsts || !hsts.includes('max-age'))
      throw new Error(`Missing strict-transport-security: ${hsts}`);

    const csp = headers.get('content-security-policy');
    if (!csp || !csp.includes("default-src 'self'")) throw new Error(`Missing or weak CSP: ${csp}`);

    const reqId = headers.get('x-request-id');
    if (!reqId) throw new Error('Missing x-request-id');

    return 'CSP, HSTS, nosniff, referrer, request-id verified';
  });

  // 6. Public Root / Static SPA
  await step('Public GET / Static Web UI', async () => {
    const res = await fetch(`${serviceUrl}/`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.includes('IndexDoctor'))
      throw new Error('IndexDoctor title missing from root response');
    return 'HTTP 200 HTML rendered';
  });

  if (!isSkeleton) {
    // 7. Test 3 Golden Presets
    for (const preset of PRESETS) {
      await step(`POST /api/diagnose preset [${preset.id}]`, async () => {
        const res = await fetch(`${serviceUrl}/api/diagnose`, {
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

        const data = await res.json();
        if (data.outcome !== 'improved') {
          throw new Error(`Expected outcome 'improved', got '${data.outcome}'`);
        }

        const usesIdx = data.plans?.after?.usesIndexes || [];
        const costBefore = data.plans?.before?.cost?.total;
        const costAfter = data.plans?.after?.cost?.total;
        return `outcome=${data.outcome}, verification=${data.verification?.status}, cost: ${costBefore ?? 'n/a'} -> ${costAfter ?? 'n/a'}, uses: [${usesIdx.join(', ')}]`;
      });
    }

    // 8. Hostile COPY schema & recovery
    await step('Hostile statement returns 422 & service recovers', async () => {
      const hostileRes = await fetch(`${serviceUrl}/api/diagnose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schema: 'COPY sensitive_data FROM STDIN;\n1\tsecret\n\\.',
          query: 'SELECT * FROM sensitive_data;',
        }),
      });

      if (hostileRes.status !== 422) {
        throw new Error(`Expected 422, got ${hostileRes.status}`);
      }

      const recoveryRes = await fetch(`${serviceUrl}/api/diagnose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schema: PRESETS[0].schema,
          query: PRESETS[0].query,
          presetId: PRESETS[0].id,
        }),
      });

      if (recoveryRes.status !== 200) {
        throw new Error(`Service failed to recover. Status: ${recoveryRes.status}`);
      }

      return '422 on hostile statement; 200 on recovery request';
    });

    // 9. Rate limiting & spoofed X-Forwarded-For check
    await step('Rate limit with spoofed leftmost XFF reaches 429', async () => {
      const clientIp = '203.0.113.195';

      // Send 15 concurrent requests from the same clientIp to exceed the burst bucket (6)
      const promises = Array.from({ length: 15 }, async (_, i) => {
        const spoofedXff = `10.0.0.${i}, ${clientIp}`;
        const res = await fetch(`${serviceUrl}/api/diagnose`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': spoofedXff,
          },
          body: JSON.stringify({
            schema: PRESETS[0].schema,
            query: `${PRESETS[0].query} -- rate limit probe ${i}`,
            presetId: PRESETS[0].id,
          }),
        });
        return res.status;
      });

      const statuses = await Promise.all(promises);
      const hit429 = statuses.includes(429);

      if (!hit429) {
        throw new Error(`Did not hit 429 rate limit. Received statuses: ${statuses.join(', ')}`);
      }

      return `Rate limiter enforced 429 using rightmost XFF (${statuses.filter((s) => s === 429).length}/15 rejected with 429)`;
    });
  }

  // 10. Cloud Logging & Invariant I4 Check
  await step('Cloud Run Logging & Secret Privacy Check (I4)', async () => {
    const sentinelTable = `zz_canary_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Send a query containing this sentinel table name
    await fetch(`${serviceUrl}/api/diagnose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema: `CREATE TABLE ${sentinelTable} (id serial PRIMARY KEY, val text);`,
        query: `SELECT * FROM ${sentinelTable} WHERE val = 'probe';`,
      }),
    });

    // Read Cloud Run logs
    const logsOutput = execFileSync(
      gcloud,
      [
        'logging',
        'read',
        `"resource.type=cloud_run_revision AND resource.labels.service_name=${serviceName}"`,
        '--limit=50',
        '--freshness=5m',
        '--format=json',
      ],
      { encoding: 'utf8', shell: true },
    );

    const logEntries = JSON.parse(logsOutput || '[]');
    for (const entry of logEntries) {
      const payloadStr = JSON.stringify(entry);
      if (payloadStr.includes('AIza') || payloadStr.includes('GEMINI_API_KEY=')) {
        throw new Error('POTENTIAL SECRET LEAK IN CLOUD LOGS!');
      }
      if (payloadStr.includes(sentinelTable)) {
        throw new Error(
          `Sentinel table name "${sentinelTable}" leaked into Cloud Logs! Violates Invariant I4.`,
        );
      }
    }

    return `Read ${logEntries.length} log entries. No secret leaks or sentinel query leaks.`;
  });

  console.log('\n======================================================');
  console.log('                 VERIFICATION REPORT                  ');
  console.log('======================================================');
  console.table(
    results.map((r) => ({
      Step: r.name,
      Status: r.status,
      'Time (ms)': r.durationMs,
      Detail: (r.detail || '').slice(0, 60),
    })),
  );

  const hasFailures = results.some((r) => r.status === 'FAIL');
  if (hasFailures) {
    console.error('\n❌ DEPLOY VERIFICATION FAILED. Review errors above.');
    process.exit(1);
  }

  console.log('\n✅ ALL DEPLOYMENT VERIFICATION CHECKS PASSED.');
  console.log(`Live Service URL: ${serviceUrl}`);
}

main().catch((err) => {
  console.error('Fatal deploy verification failure:', err);
  process.exit(1);
});
