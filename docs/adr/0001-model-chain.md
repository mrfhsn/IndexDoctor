# ADR 0001: Model Chain Order and Gemma MoE Selection

## Context

During Gate 0 probing (`scripts/probe-models.mjs`), we tested the candidate models over the Gemini API using `@google/genai` (v2.29.1) on the user's Free Tier key:

- `gemini-3.1-flash-lite` succeeded consistently with an average latency of ~1,173 ms, supporting structured output (`responseSchema`) and `thinkingConfig.thinkingLevel: MINIMAL`.
- `gemma-4-26b-a4b-it` (MoE) succeeded with an average latency of ~3,590 ms, supporting structured output (`responseSchema`) and `thinkingConfig.thinkingLevel: MINIMAL`.
- `gemini-3.5-flash-lite` repeatedly timed out (>8,000 ms) on the free tier endpoint.

## Decision

Configure default `LLM_MODELS` order in `config.ts` and `.env.example`:
`LLM_MODELS=gemini-3.1-flash-lite,gemma-4-26b-a4b-it,gemini-3.5-flash-lite`

Followed by the deterministic ESR planner fallback.

## Consequences

- Primary requests achieve fast ~1.2 s model response times with verified structured schemas.
- In the event of a 429/5xx or rate limiting on 3.1-flash-lite, the circuit breaker gracefully cascades to `gemma-4-26b-a4b-it`, then `gemini-3.5-flash-lite`, and finally to deterministic ESR rules without returning 5xx.
- No sampling parameters (`temperature`, `topP`, `topK`, `candidateCount`, `thinkingBudget`) are transmitted, conforming to invariant I9 and current API rules.
