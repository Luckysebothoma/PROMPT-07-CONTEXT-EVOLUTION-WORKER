'use strict';
// Real end-to-end test against the real Postgres + real Day 3. Creates one clearly-labelled fixture
// session, exercises the worker, then removes ONLY its own fixture rows. Nothing is mocked.
const crypto = require('crypto');
const cfg = require('./config');
const { pool, migrate } = require('./db');
const { runCycle, getCheckpoint } = require('./evolve');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
  if (!cond) failures++;
}
const q = (sql, p) => pool.query(sql, p);

// content generator - k-th message; roles alternate, so k and k-4 share role+text (used to plant duplicates)
const CONTENT = `CASE WHEN k % 2 = 1
  THEN 'Question ' || k || ': how should alert rule number ' || k || ' for disk usage on node-a be tuned, and what threshold do you recommend?'
  ELSE 'Answer ' || k || ': for alert rule number ' || k || ' on node-a we decided to page at 90 percent disk usage and warn at 80 percent.' END`;

async function addMessages(sid, from, to, dupOfFirstTwo) {
  await q(
    `INSERT INTO messages (session_id, role, content, created_at)
     SELECT $1, CASE WHEN g % 2 = 1 THEN 'user' ELSE 'assistant' END, ${CONTENT},
            now() - interval '4 hours' + g * interval '1 minute'
       FROM (SELECT g, CASE WHEN $4::boolean AND g IN (5,6) THEN g - 4 ELSE g END AS k
               FROM generate_series($2::int, $3::int) g) t`,
    [sid, from, to, !!dupOfFirstTwo]);
}
const touch = (sid, ago) => q(`UPDATE sessions SET updated_at = now() - $2::interval WHERE id = $1`, [sid, ago]);

async function run() {
  const sid = crypto.randomUUID();
  const opts = { scope: 'selftest', triggered_by: 'selftest', onlySessionIds: [sid], lagSeconds: 0 };
  try {
    // 1. real PostgreSQL + Day 4 schema + migrations
    const v = await q('SELECT version() AS v');
    check('PostgreSQL connection', /PostgreSQL/.test(v.rows[0].v), v.rows[0].v.split(' ').slice(0, 2).join(' '));
    for (const t of ['sessions', 'messages']) {
      const r = await q('SELECT to_regclass($1) AS x', ['public.' + t]);
      check('Day 4 table exists: ' + t, !!r.rows[0].x);
    }
    await migrate();
    for (const t of ['context_evolution_runs', 'context_summaries', 'context_evolution_retries']) {
      const r = await q('SELECT to_regclass($1) AS x', ['public.' + t]);
      check('Day 7 table exists: ' + t, !!r.rows[0].x);
    }
    const mig = await q(`SELECT count(*)::int AS n FROM day7_schema_migrations`);
    check('migrations recorded', mig.rows[0].n >= 1);

    // 2. Day 3 (the only AI layer) must be reachable - no faking
    let day3ok = false;
    try { const r = await fetch(cfg.day3Url + '/health'); day3ok = r.ok; } catch (_) {}
    check('Day 3 reachable at ' + cfg.day3Url, day3ok);
    if (!day3ok) { failures++; console.log('FAIL  worker/checkpoint/AI tests not run (Day 3 unreachable)'); return; }

    // 3. fixture session: 30 messages, 2 planted duplicates (positions 5 and 6), updated 30 min ago
    await q(`INSERT INTO sessions (id, user_id, agent_name, metadata, status, created_at, updated_at)
             VALUES ($1,'day7-selftest','selftest','{"day7_selftest":true}','active', now() - interval '5 hours', now() - interval '30 minutes')`, [sid]);
    await addMessages(sid, 1, 30, true);
    const s0 = (await q(`SELECT updated_at::text AS u FROM sessions WHERE id=$1`, [sid])).rows[0].u;
    const msgCount = async () => (await q(`SELECT count(*)::int AS n FROM messages WHERE session_id=$1`, [sid])).rows[0].n;
    const nthMsg = async (off) => (await q(`SELECT id FROM messages WHERE session_id=$1 ORDER BY created_at, id OFFSET $2 LIMIT 1`, [sid, off])).rows[0].id;
    const summaries = async () => (await q(`SELECT version, messages_summarised AS n, covers_through_message_id AS mid FROM context_summaries WHERE session_id=$1 ORDER BY version`, [sid])).rows;
    check('fixture inserted', (await msgCount()) === 30);

    // 4. run #1: real Day 3 call
    const r1 = await runCycle(opts);
    check('run 1 status=success', r1.status === 'success', 'status=' + r1.status + ' err=' + (r1.error || ''));
    check('run 1 examined=1 changed=1', r1.examined === 1 && r1.changed === 1);
    let sm = await summaries();
    check('summary v1 created', sm.length === 1 && sm[0].version === 1);
    check('duplicates excluded from AI input (30-10 kept-recent-2 dups = 18)', sm[0] && sm[0].n === 18, 'got ' + (sm[0] && sm[0].n));
    check('coverage marker = 20th message', sm[0] && sm[0].mid === (await nthMsg(19)));
    const meta = (await q(`SELECT metadata->'context_summary'->>'version' AS v, length(metadata->'context_summary'->>'text') AS len FROM sessions WHERE id=$1`, [sid])).rows[0];
    check('summary mirrored into sessions.metadata', meta.v === '1' && meta.len > 20, 'len=' + meta.len);
    check('sessions.updated_at untouched by Day 7', (await q(`SELECT updated_at::text AS u FROM sessions WHERE id=$1`, [sid])).rows[0].u === s0);
    check('no messages deleted or changed (non-destructive)', (await msgCount()) === 30);
    const cp1 = await getCheckpoint('selftest');
    check('checkpoint advanced to fixture session', cp1.id === sid && cp1.ts === s0, cp1.ts);

    // 5. run #2: nothing new -> idempotent
    const r2 = await runCycle(opts);
    check('run 2 idempotent (examined=0, changed=0)', r2.status === 'success' && r2.examined === 0 && r2.changed === 0);
    check('run 2 created no new summary', (await summaries()).length === 1);

    // 6. more messages -> incremental summary v2 that builds on v1
    await addMessages(sid, 31, 45, false);
    await touch(sid, '20 minutes');
    const s1 = (await q(`SELECT updated_at::text AS u FROM sessions WHERE id=$1`, [sid])).rows[0].u;
    const r3 = await runCycle(opts);
    sm = await summaries();
    check('run 3 changed=1, summary v2 created', r3.status === 'success' && r3.changed === 1 && sm.length === 2 && sm[1].version === 2);
    check('v2 covers only the new eligible messages (15)', sm[1] && sm[1].n === 15, 'got ' + (sm[1] && sm[1].n));
    check('v2 coverage marker = 35th message', sm[1] && sm[1].mid === (await nthMsg(34)));
    check('v1 preserved (append-only history)', sm[0] && sm[0].version === 1);
    check('checkpoint advanced after v2', (await getCheckpoint('selftest')).ts === s1);

    // 7. failure must NOT advance the checkpoint (Day 3 forced unreachable)
    await addMessages(sid, 46, 60, false);
    await touch(sid, '10 minutes');
    const s2 = (await q(`SELECT updated_at::text AS u FROM sessions WHERE id=$1`, [sid])).rows[0].u;
    const cpBefore = await getCheckpoint('selftest');
    const r4 = await runCycle(Object.assign({}, opts, { day3Url: 'http://127.0.0.1:9', day3Retries: 0 }));
    check('run 4 (Day 3 down) status=failed', r4.status === 'failed', 'status=' + r4.status);
    const cpAfterFail = await getCheckpoint('selftest');
    check('failed run did NOT advance checkpoint', cpAfterFail.ts === cpBefore.ts && cpAfterFail.id === cpBefore.id);
    check('failed run created no summary', (await summaries()).length === 2);
    const att = (await q(`SELECT attempts FROM context_evolution_retries WHERE session_id=$1`, [sid])).rows[0];
    check('failure recorded in retries table', att && att.attempts === 1);

    // 8. recovery: same data, real Day 3 -> succeeds, checkpoint advances
    const r5 = await runCycle(opts);
    sm = await summaries();
    check('run 5 recovers: success, summary v3', r5.status === 'success' && r5.changed === 1 && sm.length === 3);
    check('checkpoint advanced after recovery', (await getCheckpoint('selftest')).ts === s2);
    check('retries row cleared after success', (await q(`SELECT 1 FROM context_evolution_retries WHERE session_id=$1`, [sid])).rowCount === 0);

    // 9. job tracking columns populated
    const run = (await q(`SELECT * FROM context_evolution_runs WHERE id=$1`, [r5.run_id])).rows[0];
    check('run row tracked (status, started/completed, counts, checkpoint)',
      run && run.status === 'success' && run.started_at && run.completed_at && run.records_examined === 1 && run.checkpoint_after_id === sid);
  } catch (e) {
    check('unexpected exception', false, e.message);
  } finally {
    // remove ONLY this test's own fixture (FK cascade removes its messages/summaries/retries), then its run rows
    await q(`DELETE FROM sessions WHERE id=$1 AND user_id='day7-selftest'`, [sid]).catch((e) => console.log('cleanup:', e.message));
    await q(`DELETE FROM context_evolution_runs WHERE scope='selftest'`).catch((e) => console.log('cleanup:', e.message));
    await pool.end();
    console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
    process.exitCode = failures === 0 ? 0 : 1;
  }
}

module.exports = { run };
