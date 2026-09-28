'use strict';
const fs = require('fs');
const cfg = require('./config');
const { pool, migrate } = require('./db');
const { runCycle, getCheckpoint, log } = require('./evolve');

const cmd = process.argv[2] || 'daemon';

async function status() {
  await migrate();
  const cp = await getCheckpoint('main');
  const pending = (await pool.query(
    `SELECT count(*)::int AS n FROM sessions
      WHERE ($1::timestamptz IS NULL OR (updated_at, id) > ($1::timestamptz, $2::uuid))`, [cp.ts, cp.id])).rows[0].n;
  const totals = (await pool.query(
    `SELECT count(*)::int AS summaries, count(DISTINCT session_id)::int AS sessions FROM context_summaries`)).rows[0];
  const runs = (await pool.query(
    `SELECT id, status, triggered_by, started_at, records_examined AS examined, records_changed AS changed,
            records_skipped AS skipped, left(coalesce(error,''), 80) AS error
       FROM context_evolution_runs WHERE scope='main' ORDER BY started_at DESC LIMIT 5`)).rows;
  const retries = (await pool.query(`SELECT count(*)::int AS n FROM context_evolution_retries`)).rows[0].n;
  console.log('schedule            :', cfg.cron, '(' + cfg.tz + ')');
  console.log('day3                :', cfg.day3Url);
  console.log('checkpoint          :', cp.ts ? cp.ts + '  session ' + cp.id : '(none yet - first run processes from the beginning)');
  console.log('sessions pending    :', pending);
  console.log('summaries stored    :', totals.summaries, 'across', totals.sessions, 'sessions');
  console.log('sessions with errors:', retries);
  console.log('last runs:');
  if (runs.length) console.table(runs); else console.log('  (no runs yet)');
}

async function main() {
  if (cmd === 'migrate') {
    console.log('applied:', await migrate());
  } else if (cmd === 'status') {
    await status();
  } else if (cmd === 'run') {
    await migrate();
    const r = await runCycle({ scope: 'main', triggered_by: 'manual' });
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.status === 'success' ? 0 : 2;
  } else if (cmd === 'selftest') {
    await require('./selftest').run();
    return; // selftest closes the pool itself
  } else if (cmd === 'daemon') {
    const cron = require('node-cron');
    if (!cron.validate(cfg.cron)) throw new Error('invalid CONTEXT_EVOLUTION_CRON: ' + cfg.cron);
    await migrate();
    let running = false;
    const tick = async (trigger) => {
      if (running) return;
      running = true;
      try { await runCycle({ scope: 'main', triggered_by: trigger }); }
      catch (e) { log({ level: 'error', msg: 'run failed', error: e.message }); }
      finally { running = false; }
    };
    cron.schedule(cfg.cron, () => tick('schedule'), { timezone: cfg.tz });
    const beat = () => { try { fs.writeFileSync('/tmp/day7.heartbeat', String(Date.now())); } catch (_) {} };
    beat(); setInterval(beat, 30000);
    log({ level: 'info', msg: 'scheduler started', cron: cfg.cron, tz: cfg.tz });
    if (cfg.runOnStart) tick('manual');
    const bye = () => { pool.end().finally(() => process.exit(0)); };
    process.on('SIGTERM', bye); process.on('SIGINT', bye);
    return; // keep process alive
  } else {
    throw new Error('unknown command: ' + cmd);
  }
  await pool.end();
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
