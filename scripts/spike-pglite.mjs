import { Worker, isMainThread, parentPort } from 'node:worker_threads';

import { PGlite } from '@electric-sql/pglite';
import libpgQuery from 'libpg-query';

async function runSpikes() {
  console.log('=== STARTING SPIKE 0 (Node 24, PGlite 0.5.x, libpg-query) ===\n');
  const results = {};

  // S1: Init time & RSS idle
  console.log('--- S1: Init time & RSS idle ---');
  const t0 = performance.now();
  const db = new PGlite();
  await db.waitReady;
  const s1InitMs = performance.now() - t0;
  const s1RssMb = process.memoryUsage().rss / 1024 / 1024;
  console.log(`Init time: ${s1InitMs.toFixed(1)} ms`);
  console.log(`Idle RSS: ${s1RssMb.toFixed(1)} MB`);
  const s1Pass = s1RssMb < 700;
  results.S1 = { initMs: s1InitMs, rssMb: s1RssMb, pass: s1Pass };
  console.log(`S1 Result: ${s1Pass ? 'PASS' : 'FAIL (RSS >= 700MB)'}\n`);

  function extractPlan(explainRow) {
    const raw = explainRow['QUERY PLAN'];
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return arr[0].Plan;
  }

  // S2: Empty-table plan cost
  console.log('--- S2: Empty-table plan cost ---');
  await db.exec(`
    CREATE TABLE empty_orders (
      id serial primary key,
      customer_id int not null,
      status text not null,
      created_at timestamp not null
    );
  `);
  const s2Explain = await db.query(
    `EXPLAIN (FORMAT JSON) SELECT * FROM empty_orders WHERE customer_id = 42;`,
  );
  const s2Plan = extractPlan(s2Explain.rows[0]);
  console.log('Empty table plan:', {
    NodeType: s2Plan['Node Type'],
    TotalCost: s2Plan['Total Cost'],
    PlanRows: s2Plan['Plan Rows'],
  });
  const s2Pass = s2Plan['Total Cost'] < 1.0;
  results.S2 = { cost: s2Plan['Total Cost'], pass: s2Pass };
  console.log(`S2 Result: ${s2Pass ? 'PASS (cost ≈ 0)' : 'UNEXPECTED'}\n`);

  // S3: Orders-like table: 20k seed -> ANALYZE -> scale -> EXPLAIN before -> CREATE INDEX -> read reltuples -> re-scale -> EXPLAIN after
  console.log('--- S3: 20k seed, stats scaling order & plan diff ---');
  await db.exec(`
    CREATE TABLE orders (
      id serial primary key,
      customer_id int not null,
      status text not null,
      created_at timestamp not null,
      total_amount numeric not null
    );
  `);
  const tSeed0 = performance.now();
  await db.exec(`
    INSERT INTO orders (customer_id, status, created_at, total_amount)
    SELECT
      (i % 500) + 1,
      CASE (i % 4) WHEN 0 THEN 'pending' WHEN 1 THEN 'shipped' WHEN 2 THEN 'delivered' ELSE 'cancelled' END,
      '2026-01-01'::timestamp + (i || ' seconds')::interval,
      (i % 1000)::numeric + 9.99
    FROM generate_series(1, 20000) AS s(i);
  `);
  const seedMs = performance.now() - tSeed0;
  console.log(`Seeded 20,000 rows in ${seedMs.toFixed(1)} ms`);

  await db.exec(`ANALYZE orders;`);
  const initialStats = await db.query(
    `SELECT reltuples, relpages, relallvisible FROM pg_class WHERE relname = 'orders';`,
  );
  console.log('Post-ANALYZE stats:', initialStats.rows[0]);

  // Scale stats before index
  await db.exec(
    `UPDATE pg_class SET reltuples = 500000, relallvisible = relpages WHERE relname = 'orders';`,
  );
  const scaledStatsBefore = await db.query(
    `SELECT reltuples, relpages, relallvisible FROM pg_class WHERE relname = 'orders';`,
  );
  console.log('Scaled stats (before index):', scaledStatsBefore.rows[0]);

  const beforeExplain = await db.query(
    `EXPLAIN (FORMAT JSON) SELECT * FROM orders WHERE customer_id = 42 AND status = 'shipped' ORDER BY created_at DESC;`,
  );
  const beforePlan = extractPlan(beforeExplain.rows[0]);
  console.log('Before plan:', {
    NodeType: beforePlan['Node Type'],
    TotalCost: beforePlan['Total Cost'],
    PlanRows: beforePlan['Plan Rows'],
  });

  // Create index
  const tIdx0 = performance.now();
  await db.exec(
    `CREATE INDEX idx_orders_cust_status_created ON orders (customer_id, status, created_at DESC);`,
  );
  const idxMs = performance.now() - tIdx0;
  console.log(`Created index in ${idxMs.toFixed(1)} ms`);

  // Read reltuples immediately after CREATE INDEX
  const statsAfterIndex = await db.query(
    `SELECT reltuples, relpages, relallvisible FROM pg_class WHERE relname = 'orders';`,
  );
  console.log('Stats immediately AFTER CREATE INDEX:', statsAfterIndex.rows[0]);
  const statsWereReset = Number(statsAfterIndex.rows[0].reltuples) !== 500000;
  console.log(
    `Did CREATE INDEX reset/rewrite parent stats? ${statsWereReset ? 'YES (matches PostgreSQL internal behaviour)' : 'NO'}`,
  );

  // Re-scale stats
  await db.exec(
    `UPDATE pg_class SET reltuples = 500000, relallvisible = relpages WHERE relname = 'orders';`,
  );
  const statsAfterRescale = await db.query(
    `SELECT reltuples, relpages, relallvisible FROM pg_class WHERE relname = 'orders';`,
  );
  console.log('Stats after re-scaling:', statsAfterRescale.rows[0]);
  const rescaleAssert = Number(statsAfterRescale.rows[0].reltuples) === 500000;

  const afterExplain = await db.query(
    `EXPLAIN (FORMAT JSON) SELECT * FROM orders WHERE customer_id = 42 AND status = 'shipped' ORDER BY created_at DESC;`,
  );
  const afterPlan = extractPlan(afterExplain.rows[0]);
  console.log('After plan:', {
    NodeType: afterPlan['Node Type'],
    TotalCost: afterPlan['Total Cost'],
    IndexName: afterPlan['Index Name'] || afterPlan.Plans?.[0]?.['Index Name'],
    PlanRows: afterPlan['Plan Rows'],
  });

  const costDropped = afterPlan['Total Cost'] < beforePlan['Total Cost'];
  const s3Pass = rescaleAssert && costDropped;
  results.S3 = {
    statsWereReset,
    rescaleAssert,
    beforeCost: beforePlan['Total Cost'],
    afterCost: afterPlan['Total Cost'],
    costDropped,
    pass: s3Pass,
  };
  console.log(
    `S3 Result: ${s3Pass ? 'PASS (stats scaling verified, cost dropped from ' + beforePlan['Total Cost'] + ' to ' + afterPlan['Total Cost'] + ')' : 'FAIL'}\n`,
  );

  // S4: statement_timeout & terminate latency
  console.log('--- S4: statement_timeout & worker termination ---');
  let timeoutEnforced = false;
  try {
    await db.exec(`SET statement_timeout = 50;`);
    const tSleep0 = performance.now();
    await db.query(`SELECT pg_sleep(0.3);`);
    const sleepDuration = performance.now() - tSleep0;
    console.log(
      `pg_sleep(0.3) completed in ${sleepDuration.toFixed(1)} ms with statement_timeout=50ms (not aborted)`,
    );
    timeoutEnforced = false;
  } catch (err) {
    console.log('statement_timeout triggered error:', err.message);
    timeoutEnforced = true;
  }
  await db.exec(`RESET statement_timeout;`);

  // Test worker termination latency
  const workerTestScript = `
    import { parentPort } from 'node:worker_threads';
    import { PGlite } from '@electric-sql/pglite';
    const db = new PGlite();
    await db.waitReady;
    parentPort.postMessage('ready');
    // infinite or heavy query
    await db.query('SELECT count(*) FROM generate_series(1, 100000000)');
  `;
  const worker = new Worker(workerTestScript, { eval: true });
  await new Promise((resolve) => {
    worker.on('message', (m) => {
      if (m === 'ready') resolve();
    });
  });
  const tTerm0 = performance.now();
  await worker.terminate();
  const termMs = performance.now() - tTerm0;
  console.log(`Worker termination latency: ${termMs.toFixed(1)} ms`);
  const s4Pass = termMs < 1000;
  results.S4 = { timeoutEnforced, workerTerminateMs: termMs, pass: s4Pass };
  console.log(
    `S4 Result: ${s4Pass ? 'PASS' : 'FAIL'} (timeoutEnforced=${timeoutEnforced}, terminateMs=${termMs.toFixed(1)})\n`,
  );

  // S5: 20 jobs user-object count & RSS slope
  console.log('--- S5: 20 jobs object leak check & RSS slope ---');
  const rssReadings = [];
  let userObjectsLeaked = 0;
  for (let i = 0; i < 20; i++) {
    await db.exec(`
      BEGIN;
      CREATE TABLE temp_test_${i} (id int);
      INSERT INTO temp_test_${i} VALUES (1);
      ROLLBACK;
    `);
    const objCheck = await db.query(`
      SELECT count(*) as cnt FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname LIKE 'temp_test_%';
    `);
    const count = Number(objCheck.rows[0].cnt);
    if (count > 0) userObjectsLeaked += count;
    rssReadings.push(process.memoryUsage().rss / 1024 / 1024);
  }
  const rssStart = rssReadings[0];
  const rssEnd = rssReadings[rssReadings.length - 1];
  const rssSlope = rssEnd - rssStart;
  console.log(`20 jobs completed. Leaked objects: ${userObjectsLeaked}`);
  console.log(
    `RSS start: ${rssStart.toFixed(1)} MB, RSS end: ${rssEnd.toFixed(1)} MB, diff: ${rssSlope.toFixed(1)} MB`,
  );
  const s5Pass = userObjectsLeaked === 0 && rssSlope < 150;
  results.S5 = { userObjectsLeaked, rssSlopeMb: rssSlope, pass: s5Pass };
  console.log(`S5 Result: ${s5Pass ? 'PASS' : 'FAIL'}\n`);

  // S6: Terminate -> Respawn -> Ready time & RSS
  console.log('--- S6: Terminate -> Respawn -> Ready time ---');
  const workerLifecyleScript = `
    import { parentPort } from 'node:worker_threads';
    import { PGlite } from '@electric-sql/pglite';
    const db = new PGlite();
    await db.waitReady;
    parentPort.postMessage('ready');
  `;
  const w1 = new Worker(workerLifecyleScript, { eval: true });
  await new Promise((r) => w1.on('message', r));
  await w1.terminate();

  const tRespawn0 = performance.now();
  const w2 = new Worker(workerLifecyleScript, { eval: true });
  await new Promise((r) => w2.on('message', r));
  const respawnMs = performance.now() - tRespawn0;
  await w2.terminate();
  console.log(`Respawn to ready time: ${respawnMs.toFixed(1)} ms`);
  const s6Pass = respawnMs < 6000;
  results.S6 = { respawnMs, pass: s6Pass };
  console.log(`S6 Result: ${s6Pass ? 'PASS' : 'FAIL'}\n`);

  // S7: libpg-query AST & 20 KB hostile input benchmark
  console.log('--- S7: libpg-query AST & parse benchmark ---');
  const parser = libpgQuery.default || libpgQuery;
  const sampleSql = `
    CREATE TABLE users (id serial primary key, email varchar(255) not null);
    SELECT id, email FROM users WHERE email = 'test@example.com';
  `;
  const tParse0 = performance.now();
  const parsed = await parser.parse(sampleSql);
  const parseMs = performance.now() - tParse0;
  console.log(`Parsed sample SQL in ${parseMs.toFixed(2)} ms`);
  const astMatches = Boolean(
    parsed.stmts?.[0]?.stmt?.CreateStmt && parsed.stmts?.[1]?.stmt?.SelectStmt,
  );
  console.log('AST node types CreateStmt & SelectStmt present:', astMatches);

  // Hostile 20 KB input (deep parens, nested expressions, large query)
  let hostileSql =
    'SELECT * FROM users WHERE ' + Array(200).fill("((id = 1 AND email = 'foo'))").join(' AND ');
  while (Buffer.byteLength(hostileSql) < 20000) {
    hostileSql += ' AND (id > 0)';
  }
  const hostileBytes = Buffer.byteLength(hostileSql);
  const tHostile0 = performance.now();
  const parsedHostile = await parser.parse(hostileSql);
  const hostileMs = performance.now() - tHostile0;
  console.log(`Parsed hostile ${hostileBytes} byte SQL in ${hostileMs.toFixed(2)} ms`);
  const s7Pass = astMatches && hostileMs < 50;
  results.S7 = { parseMs, hostileMs, hostileBytes, pass: s7Pass };
  console.log(`S7 Result: ${s7Pass ? 'PASS' : 'FAIL'}\n`);

  // S8: UPDATE pg_class allowed & session_replication_role & Bitmap Scan
  console.log('--- S8: Engine permissions & Bitmap Scan check ---');
  let pgClassAllowed = false;
  let repRoleAllowed = false;
  try {
    await db.exec(`UPDATE pg_class SET reltuples = 100 WHERE relname = 'empty_orders';`);
    pgClassAllowed = true;
  } catch (e) {
    console.error('UPDATE pg_class error:', e.message);
  }
  try {
    await db.exec(
      `SET session_replication_role = replica; SET session_replication_role = DEFAULT;`,
    );
    repRoleAllowed = true;
  } catch (e) {
    console.error('session_replication_role error:', e.message);
  }

  // Check if planner can pick Bitmap Scan
  await db.exec(`
    CREATE TABLE items (id serial primary key, cat int, tag int, descr text);
    INSERT INTO items (cat, tag, descr) SELECT (i % 20), (i % 30), 'item ' || i FROM generate_series(1, 25000) s(i);
    CREATE INDEX idx_items_cat ON items (cat);
    CREATE INDEX idx_items_tag ON items (tag);
    ANALYZE items;
  `);
  const bitmapExplain = await db.query(`
    EXPLAIN (FORMAT JSON) SELECT * FROM items WHERE cat = 5 OR tag = 7;
  `);
  const bitmapPlanStr = JSON.stringify(bitmapExplain.rows[0]['QUERY PLAN']);
  const pickedBitmap =
    bitmapPlanStr.includes('Bitmap Index Scan') || bitmapPlanStr.includes('Bitmap Heap Scan');
  console.log('Bitmap scan observed on OR condition:', pickedBitmap);

  const s8Pass = pgClassAllowed && repRoleAllowed;
  results.S8 = { pgClassAllowed, repRoleAllowed, pickedBitmap, pass: s8Pass };
  console.log(`S8 Result: ${s8Pass ? 'PASS' : 'FAIL'}\n`);

  await db.close();

  console.log('=== SPIKE 0 SUMMARY TABLE ===');
  console.table(
    Object.entries(results).map(([k, v]) => ({
      Spike: k,
      Pass: v.pass ? 'PASS' : 'FAIL',
      Details: JSON.stringify(v),
    })),
  );

  return results;
}

runSpikes().catch((err) => {
  console.error('Fatal Spike Error:', err);
  process.exit(1);
});
