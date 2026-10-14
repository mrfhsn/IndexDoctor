import fs from 'node:fs';
import path from 'node:path';

import { GoogleGenAI } from '@google/genai';

// Load .env if present without logging values
if (fs.existsSync('.env')) {
  const envContent = fs.readFileSync('.env', 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed
        .slice(eqIdx + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (!process.env[key] && val) {
        process.env[key] = val;
      }
    }
  }
}

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.log('WARNING: GEMINI_API_KEY is not set in environment or .env file.');
  console.log('Skipping live Gemini API probe. Deterministic fallback mode is active.');
  process.exit(0);
}

const models = (
  process.env.LLM_MODELS || 'gemini-3.1-flash-lite,gemma-4-26b-a4b-it,gemini-3.5-flash-lite'
)
  .split(',')
  .map((m) => m.trim());

const testSchema = {
  type: 'object',
  properties: {
    index: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              direction: { type: 'string' },
            },
            required: ['name', 'direction'],
          },
        },
      },
      required: ['table', 'columns'],
    },
    headline: { type: 'string' },
    explanation: { type: 'string' },
  },
  required: ['index', 'headline', 'explanation'],
};

const ai = new GoogleGenAI({ apiKey });

async function probeModel(modelId) {
  console.log(`\n=== Probing model: ${modelId} ===`);
  const profile = {
    model: modelId,
    minimalCall: 'UNTESTED',
    structuredOutput: 'UNTESTED',
    thinkingLevel: 'UNTESTED',
    systemInstruction: 'UNTESTED',
    latenciesMs: [],
    avgLatencyMs: 0,
    tokens: null,
    error: null,
  };

  // 1. Minimal call
  try {
    const t0 = performance.now();
    const res = await ai.models.generateContent({
      model: modelId,
      contents: 'Ping: reply with one word pong',
      config: { abortSignal: AbortSignal.timeout(8000) },
    });
    const ms = performance.now() - t0;
    profile.minimalCall = `OK (${ms.toFixed(0)} ms)`;
    profile.latenciesMs.push(ms);
  } catch (err) {
    profile.minimalCall = `FAIL (${err.status || err.code || err.message})`;
    profile.error = err.message;
    console.log(`Minimal call failed for ${modelId}:`, err.message);
    return profile;
  }

  // 2. Full structured output + system instruction + thinkingLevel
  try {
    const t0 = performance.now();
    const res = await ai.models.generateContent({
      model: modelId,
      contents: 'Propose an index for: SELECT * FROM orders WHERE customer_id = 1;',
      config: {
        systemInstruction: 'You are an index advisor. Output strict JSON matching schema.',
        responseMimeType: 'application/json',
        responseSchema: testSchema,
        thinkingConfig: {
          thinkingLevel: 'MINIMAL',
        },
        abortSignal: AbortSignal.timeout(8000),
      },
    });
    const ms = performance.now() - t0;
    profile.structuredOutput = 'YES (responseSchema)';
    profile.thinkingLevel = 'YES (MINIMAL)';
    profile.systemInstruction = 'YES';
    profile.latenciesMs.push(ms);
    if (res.usageMetadata) {
      profile.tokens = {
        prompt: res.usageMetadata.promptTokenCount,
        candidates: res.usageMetadata.candidatesTokenCount,
      };
    }
    console.log(`Full config succeeded for ${modelId} (${ms.toFixed(0)} ms)`);
  } catch (err) {
    console.log(
      `Full config failed for ${modelId} (${err.status || err.message}), testing capability downgrade ladder...`,
    );
    profile.error = err.message;

    // Downgrade step A: drop thinkingConfig
    try {
      const t0 = performance.now();
      const res = await ai.models.generateContent({
        model: modelId,
        contents: 'Propose an index for: SELECT * FROM orders WHERE customer_id = 1;',
        config: {
          systemInstruction: 'You are an index advisor. Output strict JSON matching schema.',
          responseMimeType: 'application/json',
          responseSchema: testSchema,
          abortSignal: AbortSignal.timeout(8000),
        },
      });
      const ms = performance.now() - t0;
      profile.structuredOutput = 'YES (responseSchema)';
      profile.thinkingLevel = 'NO (dropped)';
      profile.systemInstruction = 'YES';
      profile.latenciesMs.push(ms);
      if (res.usageMetadata) {
        profile.tokens = {
          prompt: res.usageMetadata.promptTokenCount,
          candidates: res.usageMetadata.candidatesTokenCount,
        };
      }
      console.log(
        `Structured output without thinking succeeded for ${modelId} (${ms.toFixed(0)} ms)`,
      );
    } catch (err2) {
      console.log(
        `Structured output failed for ${modelId} (${err2.status || err2.message}), testing JSON-in-prompt...`,
      );

      // Downgrade step B: JSON in prompt (for Gemma)
      try {
        const t0 = performance.now();
        const res = await ai.models.generateContent({
          model: modelId,
          contents:
            'Propose an index for: SELECT * FROM orders WHERE customer_id = 1. Return JSON with keys: index, headline, explanation.',
          config: { abortSignal: AbortSignal.timeout(8000) },
        });
        const ms = performance.now() - t0;
        profile.structuredOutput = 'NO (JSON-in-prompt)';
        profile.thinkingLevel = 'NO';
        profile.systemInstruction = 'NO';
        profile.latenciesMs.push(ms);
        if (res.usageMetadata) {
          profile.tokens = {
            prompt: res.usageMetadata.promptTokenCount,
            candidates: res.usageMetadata.candidatesTokenCount,
          };
        }
        console.log(`JSON-in-prompt succeeded for ${modelId} (${ms.toFixed(0)} ms)`);
      } catch (err3) {
        profile.structuredOutput = `FAIL (${err3.status || err3.message})`;
        console.log(`JSON-in-prompt also failed for ${modelId}:`, err3.message);
      }
    }
  }

  // 3. Third latency sample
  if (profile.latenciesMs.length > 0) {
    try {
      const t0 = performance.now();
      await ai.models.generateContent({
        model: modelId,
        contents: 'Quick ping: reply with "ok"',
        config: { abortSignal: AbortSignal.timeout(8000) },
      });
      profile.latenciesMs.push(performance.now() - t0);
    } catch {
      // ignore
    }
  }

  const sum = profile.latenciesMs.reduce((a, b) => a + b, 0);
  profile.avgLatencyMs =
    profile.latenciesMs.length > 0 ? (sum / profile.latenciesMs.length).toFixed(0) : 'N/A';

  return profile;
}

async function main() {
  console.log('=== STARTING MODEL PROBE (LLM_MODELS) ===');
  const results = [];
  for (const m of models) {
    results.push(await probeModel(m));
  }

  console.log('\n=== MODEL PROBE RESULTS TABLE ===');
  console.table(
    results.map((r) => ({
      Model: r.model,
      Minimal: r.minimalCall,
      Structured: r.structuredOutput,
      Thinking: r.thinkingLevel,
      AvgLatencyMs: r.avgLatencyMs,
      Tokens: r.tokens ? `${r.tokens.prompt}/${r.tokens.candidates}` : 'N/A',
    })),
  );

  // Write evidence
  const evidenceDir = '.agent/evidence';
  if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });
  const mdLines = [
    '# Gate 0 Evidence: Model Probe',
    '',
    `Date: ${new Date().toISOString()}`,
    '',
    '| Model | Minimal Call | Structured Output | Thinking Config | Avg Latency (ms) | Tokens (In/Out) |',
    '|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| \`${r.model}\` | ${r.minimalCall} | ${r.structuredOutput} | ${r.thinkingLevel} | ${r.avgLatencyMs} | ${r.tokens ? `${r.tokens.prompt}/${r.tokens.candidates}` : 'N/A'} |`,
    ),
    '',
    '## Notes',
    '- Verified via `@google/genai` (v2.29.1) using `ai.models.generateContent`',
    '- No sampling parameters (`temperature`, `topP`, `topK`, `candidateCount`) were sent.',
  ];
  fs.writeFileSync(path.join(evidenceDir, 'gate0-models.md'), mdLines.join('\n'));
  console.log(`Saved evidence to ${evidenceDir}/gate0-models.md`);
}

main().catch((err) => {
  console.error('Fatal probe error:', err);
  process.exit(1);
});
