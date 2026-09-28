'use strict';
const int = (k, d) => {
  const v = parseInt(process.env[k] || '', 10);
  return Number.isFinite(v) ? v : d;
};
module.exports = {
  databaseUrl: process.env.DATABASE_URL,
  day3Url: (process.env.DAY3_URL || 'http://192.168.0.140:4405').replace(/\/$/, ''),
  provider: process.env.DAY7_PROVIDER || '',
  model: process.env.DAY7_MODEL || '',
  day3TimeoutMs: int('DAY3_TIMEOUT_MS', 60000),
  cron: process.env.CONTEXT_EVOLUTION_CRON || '0 2 * * *',
  tz: process.env.CONTEXT_EVOLUTION_TZ || 'Africa/Johannesburg',
  runOnStart: process.env.RUN_ON_START === 'true',
  keepRecent: int('KEEP_RECENT_MESSAGES', 10),
  minNew: int('MIN_NEW_MESSAGES', 10),
  maxSessions: int('MAX_SESSIONS_PER_RUN', 200),
  maxAiCalls: int('MAX_AI_CALLS_PER_RUN', 100),
  lagSeconds: int('SAFETY_LAG_SECONDS', 60),
  maxInputChars: int('MAX_INPUT_CHARS', 12000),
  maxMsgChars: int('MAX_MESSAGE_CHARS', 2000),
  maxSummaryChars: int('MAX_SUMMARY_CHARS', 4000),
  maxTokens: int('MAX_TOKENS', 900),
  maxAttempts: int('MAX_ATTEMPTS', 3),
};
