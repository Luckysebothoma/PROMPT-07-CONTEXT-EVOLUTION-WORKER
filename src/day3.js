'use strict';
// The ONLY way Day 7 gets AI: Day 3 POST /v1/execute. No provider code lives here.
const crypto = require('crypto');
const cfg = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractText(r) {
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') return r.text || r.content || (r.message && r.message.content) || '';
  return '';
}

async function execute(messages, opts = {}) {
  const url = (opts.day3Url || cfg.day3Url).replace(/\/$/, '');
  const retries = Number.isInteger(opts.day3Retries) ? opts.day3Retries : 2;
  const body = { messages, temperature: 0.2, max_tokens: cfg.maxTokens };
  if (cfg.provider) body.provider = cfg.provider;
  if (cfg.model) body.model = cfg.model;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.day3TimeoutMs);
    try {
      const res = await fetch(url + '/v1/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-ID': crypto.randomUUID() },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      let json = null;
      try { json = await res.json(); } catch (_) { /* non-JSON body */ }
      if (res.ok && json && json.success) {
        const text = String(extractText(json.response)).trim();
        if (!text) { const e = new Error('Day 3 returned an empty response'); e.permanent = true; throw e; }
        return { text, provider: json.provider || null, model: json.model || null };
      }
      const em = json && json.error;
      const emsg = em ? (typeof em === 'string' ? em : em.message) : 'no body';
      const err = new Error('Day 3 HTTP ' + res.status + ': ' + emsg);
      if (res.status < 500 && res.status !== 429 && res.status !== 408) err.permanent = true;
      throw err;
    } catch (e) {
      lastErr = e;
      if (e.permanent || attempt === retries) break;
      await sleep(2000 * (attempt + 1) * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

module.exports = { execute };
