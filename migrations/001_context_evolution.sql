-- Day 7 - Context Evolution Worker: minimum additive metadata.
-- Reads Day 4's existing tables (sessions, messages). Never alters or deletes their rows.

-- One row per execution. The latest success/partial row of a scope IS the checkpoint.
CREATE TABLE IF NOT EXISTS context_evolution_runs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope                TEXT NOT NULL DEFAULT 'main',      -- 'main' in production, 'selftest' in tests
  triggered_by         TEXT NOT NULL DEFAULT 'schedule',  -- schedule | manual | selftest
  status               TEXT NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running','success','partial','failed')),
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ,
  records_examined     INTEGER NOT NULL DEFAULT 0,
  records_changed      INTEGER NOT NULL DEFAULT 0,
  records_skipped      INTEGER NOT NULL DEFAULT 0,
  error                TEXT,
  checkpoint_before_ts TIMESTAMPTZ,
  checkpoint_before_id UUID,
  checkpoint_after_ts  TIMESTAMPTZ,
  checkpoint_after_id  UUID,
  detail               JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_ctx_evo_runs_scope_done ON context_evolution_runs (scope, completed_at DESC);

-- Append-only, versioned rolling summaries (audit trail; nothing is ever overwritten).
CREATE TABLE IF NOT EXISTS context_summaries (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  version                   INTEGER NOT NULL,
  summary                   TEXT NOT NULL,
  covers_through_message_id UUID NOT NULL,
  covers_through_at         TIMESTAMPTZ NOT NULL,
  messages_summarised       INTEGER NOT NULL,
  source_run_id             UUID REFERENCES context_evolution_runs(id),
  provider                  TEXT,
  model                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, version)
);

-- Poison-pill guard: a session that keeps failing must not block the checkpoint forever.
CREATE TABLE IF NOT EXISTS context_evolution_retries (
  session_id      UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Additive indexes on Day 4 tables so incremental (watermark) reads stay cheap.
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at_id ON sessions (updated_at, id);
CREATE INDEX IF NOT EXISTS idx_messages_session_created_id ON messages (session_id, created_at, id);
