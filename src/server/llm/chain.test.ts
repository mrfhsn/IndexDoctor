import { describe, expect, it } from 'vitest';

import { parseConfig } from '../config.js';
import { buildCatalog } from '../sql/catalog.js';
import { parseSql } from '../sql/parse.js';
import { ModelCircuitBreaker } from './breaker.js';
import { LlmChain } from './chain.js';
import { LlmClient, type GenerateContentFn } from './client.js';

const schemaSql = `
  CREATE TABLE orders (
    id serial primary key,
    customer_id int not null,
    status varchar(20) not null,
    created_at timestamp not null
  );
`;

const successGenerator: GenerateContentFn = async (modelId) => {
  expect(modelId).toBe('model-a');
  return {
    text: JSON.stringify({
      index: {
        table: 'orders',
        columns: [{ name: 'customer_id' }, { name: 'created_at', direction: 'desc' }],
      },
      headline: 'Composite index on orders',
      explanation: 'Filters by customer_id and preserves ordering on created_at.',
      antiPatterns: [],
      esr: [{ column: 'customer_id', reason: 'Equality filter' }],
    }),
  };
};

const fallbackGenerator: GenerateContentFn = async (modelId) => {
  if (modelId === 'model-a') {
    const err = Object.assign(new Error('HTTP 404: model retired'), { status: 404 });
    throw err;
  }
  return {
    text: JSON.stringify({
      index: {
        table: 'orders',
        columns: [{ name: 'customer_id' }],
      },
      headline: 'Index customer_id',
      explanation: 'Speeds up equality filtering.',
    }),
  };
};

const invalidColGenerator: GenerateContentFn = async () => ({
  text: JSON.stringify({
    index: {
      table: 'orders',
      columns: [{ name: 'hallucinated_column_xyz' }],
    },
    headline: 'Hallucinated index',
    explanation: 'Invalid column proposal.',
  }),
});

async function getFixtures(querySql = 'SELECT * FROM orders WHERE customer_id = 42;') {
  const parsedSchema = await parseSql(schemaSql);
  const catalog = buildCatalog(parsedSchema.stmts);
  const parsedQuery = await parseSql(querySql);
  const queryAst = parsedQuery.stmts[0];
  if (!queryAst) throw new Error('Query parsed to empty');
  const queryReferencedTables = new Set(['orders']);

  return {
    catalog,
    queryAst,
    querySql,
    queryReferencedTables,
  };
}

describe('llm/chain', () => {
  it('skips chain and runs deterministic planner when GEMINI_API_KEY is unset', async () => {
    const config = parseConfig({
      GEMINI_API_KEY: '',
      LLM_MODELS: 'gemini-3.1-flash-lite',
    });
    const fixtures = await getFixtures();

    const chain = new LlmChain({ config });
    const result = await chain.execute(fixtures);

    expect(result.proposedBy).toBe('deterministic');
    expect(result.model).toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.outcome).toBe('no_key');
    expect(result.spec?.table).toBe('orders');
    expect(result.spec?.columns[0]?.name).toBe('customer_id');
  });

  it('returns LLM recommendation when primary model succeeds', async () => {
    const config = parseConfig({
      GEMINI_API_KEY: 'test-key',
      LLM_MODELS: 'model-a,model-b',
    });
    const fixtures = await getFixtures();

    const client = new LlmClient({ generator: successGenerator });
    const breaker = new ModelCircuitBreaker();
    const chain = new LlmChain({ config, client, breaker });

    const result = await chain.execute(fixtures);

    expect(result.proposedBy).toBe('llm');
    expect(result.model).toBe('model-a');
    expect(result.spec?.table).toBe('orders');
    expect(result.spec?.columns).toHaveLength(2);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.outcome).toBe('ok');
    expect(breaker.isOpen('model-a')).toBe(false);
  });

  it('falls back to secondary model when primary model fails with HTTP error', async () => {
    const config = parseConfig({
      GEMINI_API_KEY: 'test-key',
      LLM_MODELS: 'model-a,model-b',
    });
    const fixtures = await getFixtures();

    const client = new LlmClient({ generator: fallbackGenerator });
    const breaker = new ModelCircuitBreaker();
    const chain = new LlmChain({ config, client, breaker });

    const result = await chain.execute(fixtures);

    expect(result.proposedBy).toBe('llm');
    expect(result.model).toBe('model-b');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.model).toBe('model-a');
    expect(result.attempts[0]?.outcome).toBe('http_error');
    expect(result.attempts[1]?.model).toBe('model-b');
    expect(result.attempts[1]?.outcome).toBe('ok');
    expect(breaker.isOpen('model-a')).toBe(true); // 404 opens breaker
  });

  it('skips models with open circuit breakers', async () => {
    const config = parseConfig({
      GEMINI_API_KEY: 'test-key',
      LLM_MODELS: 'model-a,model-b',
    });
    const fixtures = await getFixtures();

    const breaker = new ModelCircuitBreaker();
    breaker.recordFailure('model-a', { status: 401 }); // opens breaker for model-a

    let modelBCalled = false;
    const generator: GenerateContentFn = async (modelId) => {
      if (modelId === 'model-b') {
        modelBCalled = true;
        return {
          text: JSON.stringify({
            index: null,
            headline: 'No index required',
            explanation: 'Query already efficient.',
          }),
        };
      }
      throw new Error('model-a should not be called');
    };

    const client = new LlmClient({ generator });
    const chain = new LlmChain({ config, client, breaker });

    const result = await chain.execute(fixtures);

    expect(modelBCalled).toBe(true);
    expect(result.proposedBy).toBe('llm');
    expect(result.model).toBe('model-b');
    expect(result.attempts[0]?.model).toBe('model-a');
    expect(result.attempts[0]?.outcome).toBe('skipped_breaker');
  });

  it('triggers repair turn on malformed JSON and accepts repaired output', async () => {
    const config = parseConfig({
      GEMINI_API_KEY: 'test-key',
      LLM_MODELS: 'model-a',
    });
    const fixtures = await getFixtures();

    let calls = 0;
    const generator: GenerateContentFn = async (_model, _contents, _config) => {
      calls += 1;
      if (calls === 1) {
        // Return malformed JSON
        return { text: '{ incomplete_json: true' };
      }
      // Repaired output
      return {
        text: JSON.stringify({
          index: {
            table: 'orders',
            columns: [{ name: 'customer_id' }],
          },
          headline: 'Repaired recommendation',
          explanation: 'Valid after repair.',
        }),
      };
    };

    const client = new LlmClient({ generator });
    const chain = new LlmChain({ config, client });

    const result = await chain.execute({
      ...fixtures,
      deadlineMs: 10000,
    });

    expect(calls).toBe(2);
    expect(result.proposedBy).toBe('llm');
    expect(result.spec?.table).toBe('orders');
    expect(result.headline).toBe('Repaired recommendation');
  });

  it('falls back to deterministic ESR planner when model proposes invalid column', async () => {
    const config = parseConfig({
      GEMINI_API_KEY: 'test-key',
      LLM_MODELS: 'model-a',
    });
    const fixtures = await getFixtures();

    const client = new LlmClient({ generator: invalidColGenerator });
    const chain = new LlmChain({ config, client });

    const result = await chain.execute(fixtures);

    // LLM attempt failed validation, falling back to deterministic ESR planner
    expect(result.proposedBy).toBe('deterministic');
    expect(result.model).toBeNull();
    expect(result.spec?.columns[0]?.name).toBe('customer_id');
    expect(result.attempts[0]?.outcome).toBe('invalid_output');
  });
});
