'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const cfg = require('./config');

if (!cfg.databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const pool = new Pool({ connectionString: cfg.databaseUrl, max: 5, connectionTimeoutMillis: 10000 });
pool.on('error', () => {});

async function assertDay4Schema() {
  for (const t of ['sessions', 'messages']) {
    const r = await pool.query('SELECT to_regclass($1) AS x', ['public.' + t]);
    if (!r.rows[0].x) {
      throw new Error('Day 4 table "' + t + '" not found - DATABASE_URL must point at the Day 4 database');
    }
  }
}

async function migrate() {
  await assertDay4Schema();
  await pool.query(
    'CREATE TABLE IF NOT EXISTS day7_schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
  );
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const f of files) {
    const done = await pool.query('SELECT 1 FROM day7_schema_migrations WHERE name = $1', [f]);
    if (done.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await client.query('INSERT INTO day7_schema_migrations (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      applied.push(f);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error('migration ' + f + ' failed: ' + e.message);
    } finally {
      client.release();
    }
  }
  return applied;
}

module.exports = { pool, migrate, assertDay4Schema };
