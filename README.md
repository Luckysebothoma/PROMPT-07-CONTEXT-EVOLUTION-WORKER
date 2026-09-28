# Day 7 - Context Evolution Worker

Scheduled worker. PostgreSQL (Day 4 database) is the source of truth; Day 3 `/v1/execute` is the only AI call.

    sessions.updated_at (Day 4 change signal) -> watermark -> new messages -> Day 3 summary -> context_summaries (+ mirror in sessions.metadata.context_summary)

* Newest KEEP_RECENT_MESSAGES stay verbatim; older ones roll into a versioned summary (append-only).
* Exact-duplicate / empty messages are left out of the AI input only; nothing is deleted.
* Checkpoint = latest success/partial row in `context_evolution_runs`. Failed runs never advance it.
* A session failing MAX_ATTEMPTS times is skipped until it changes again, so it cannot block the checkpoint.

## Making Day 4 use it (Day 7 does not modify Day 4)
In Day 4 `buildContext()` prepend the summary to the system text:

    const sr = await pool.query("SELECT metadata->'context_summary'->>'text' AS t FROM sessions WHERE id=$1", [sessionId]);
    const summary = sr.rows[0] && sr.rows[0].t;
    const system = [systemInstruction || '', summary ? 'Earlier conversation summary:\n' + summary : ''].filter(Boolean).join('\n\n');

Also note: Day 4 `getMessages()` uses `ORDER BY created_at ASC LIMIT N` = the OLDEST N messages. Once a
session has more than N messages the newest turns never reach the context; use DESC + reverse.

## Roll back (reversible)
    UPDATE sessions SET metadata = metadata - 'context_summary' WHERE metadata ? 'context_summary';
History stays in `context_summaries`. To reprocess from scratch: `DELETE FROM context_evolution_runs WHERE scope='main';`
# PROMPT-07-CONTEXT-EVOLUTION-WORKER
