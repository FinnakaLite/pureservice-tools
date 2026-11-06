// PureService API spike — answers the open questions in docs/PROPOSAL.md §9.
//
// Read-only by default. Prints only the STRUCTURE of production data (field names,
// types, ids, timestamps) — never note text — except for the one test ticket you
// name in PS_TEST_TICKET, whose notes are printed in full.
//
//   node --env-file=spike/.env spike/probe.mjs                 # read-only probes
//   node --env-file=spike/.env spike/probe.mjs --write         # + post one test note on the test ticket
//   node --env-file=spike/.env spike/probe.mjs --write --mention   # + copy a mention from the test ticket into it
//
// Output: console + spike/report.md (+ spike/test-ticket-raw.json); falls back to %TEMP% if blocked.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Writes next to this script; if Windows "Controlled folder access" (or similar)
// blocks node.exe from writing under Documents, falls back to the temp folder.
// No mkdir: creating folders under a protected folder can hang instead of failing.
function save(name, content) {
  for (const dir of [HERE, tmpdir()]) {
    const p = join(dir, name);
    try { writeFileSync(p, content); return p; } catch (e) { console.error(`(could not write ${p}: ${e.code ?? e.message})`); }
  }
  return null;
}

const rawBase = (process.env.PS_BASE_URL || '').trim().replace(/\/+$/, '');
const KEY = (process.env.PS_API_KEY || '').trim();
const TEST_REQ = (process.env.PS_TEST_TICKET || '').trim();
const WRITE = process.argv.includes('--write');
const MENTION = process.argv.includes('--mention');

if (!rawBase || !KEY) {
  console.error('Set PS_BASE_URL and PS_API_KEY in spike/.env (see spike/.env.example).');
  process.exit(1);
}
const API = rawBase.endsWith('/agent/api') ? rawBase : `${rawBase}/agent/api`;

// ---------------------------------------------------------------- reporting
const lines = [];
const findings = {};
const log = (s = '') => { console.log(s); lines.push(s); };
const h = (s) => log(`\n## ${s}\n`);
const finding = (q, verdict, detail) => { findings[q] = { verdict, detail }; log(`**${verdict}** — ${detail}`); };

// ---------------------------------------------------------------- http (gentle)
let requestCount = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rateHeaders = new Map();

async function call(method, path, { query, body } = {}) {
  const url = new URL(API + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 2; attempt++) {
    await sleep(800); // ~75 req/min ceiling even if nothing else throttles; we make ~20 total
    requestCount++;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'X-Authorization-Key': KEY,
          Accept: 'application/vnd.api+json',
          ...(body ? { 'Content-Type': 'application/vnd.api+json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      return { status: 0, error: String(e), url: url.pathname + url.search };
    }
    for (const [k, v] of res.headers) if (/rate|limit|retry|quota/i.test(k)) rateHeaders.set(k, v);
    if (res.status === 429 && attempt === 0) {
      const wait = Number(res.headers.get('retry-after') || 15);
      log(`  (429 — waiting ${wait}s as instructed)`);
      await sleep(wait * 1000);
      continue;
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, json, text: json ? undefined : text.slice(0, 300), url: url.pathname + url.search };
  }
}

// ---------------------------------------------------------------- shape helpers (no PII)
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
function entities(body) {
  if (!body || typeof body !== 'object') return [];
  for (const [k, v] of Object.entries(body)) if (Array.isArray(v) && k !== 'errors') return v;
  return [];
}
function safeValue(key, v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    if (ISO.test(v)) return v;
    if (/^(id|type|direction|visibility)$/i.test(key)) return JSON.stringify(v);
    return `<string, ${v.length} chars${/<[a-z][^>]*>/i.test(v) ? ', contains HTML tags' : ''}>`;
  }
  if (Array.isArray(v)) return `<array[${v.length}]>`;
  return `<object keys: ${Object.keys(v).join(', ')}>`;
}
function describe(entity) {
  return Object.entries(entity).map(([k, v]) => {
    if (k === 'links' && v && typeof v === 'object') {
      const l = Object.entries(v).map(([lk, lv]) => `${lk}=${lv && typeof lv === 'object' ? JSON.stringify(Object.fromEntries(Object.entries(lv).filter(([x]) => /id|type/i.test(x)))) : lv}`);
      return `  - links: ${l.join('; ')}`;
    }
    return `  - ${k}: ${typeof v === 'object' && v !== null ? (Array.isArray(v) ? 'array' : 'object') : typeof v} = ${safeValue(k, v)}`;
  }).join('\n');
}
const pick = (e, ...names) => { for (const n of names) if (e && e[n] !== undefined) return [n, e[n]]; return [null, undefined]; };
const createdOf = (e) => pick(e, 'created', 'createdAt', 'createdDate')[1];
const ticketIdOf = (e) => pick(e, 'ticketId')[1] ?? e?.links?.ticket?.id;
const authorIdOf = (e) => pick(e, 'createdById', 'createdBy')[1] ?? e?.links?.createdBy?.id;
const statusLine = (r) => `HTTP ${r.status} ${r.url}${r.error ? ' ' + r.error : ''}${r.text ? ' — ' + r.text.replace(/\s+/g, ' ') : ''}${r.json?.errors ? ' — ' + JSON.stringify(r.json.errors) : ''}`;

// ---------------------------------------------------------------- probes
log(`# PureService API spike report`);
log(`Run: ${new Date().toISOString()}  ·  API: ${API}  ·  test ticket: ${TEST_REQ || '(none)'}  ·  write: ${WRITE}${MENTION ? ' + mention' : ''}`);

h('P1 · Authentication');
const p1 = await call('GET', '/status/', { query: { limit: '1' } });
log(statusLine(p1));
if (p1.status !== 200) {
  finding('auth', 'FAIL', 'API key/base URL not accepted — fix before anything else.');
  finish();
  process.exit(2);
}
finding('auth', 'OK', `Key accepted. Top-level keys: ${Object.keys(p1.json || {}).join(', ')}`);

h('P2 · Communication entity shape (Q1)');
let sortField = 'created';
let p2 = await call('GET', '/communication/', { query: { limit: '3', sort: 'created desc' } });
if (p2.status !== 200) {
  log(`sort=created desc failed: ${statusLine(p2)} — retrying with id desc`);
  sortField = 'id';
  p2 = await call('GET', '/communication/', { query: { limit: '3', sort: 'id desc' } });
}
log(statusLine(p2));
log(`Response top-level keys: ${Object.keys(p2.json || {}).join(', ')}`);
const sample = entities(p2.json);
if (sample[0]) {
  log('Fields of the newest communication (values redacted unless id/enum/timestamp):');
  log(describe(sample[0]));
  finding('shape', 'OK', `created field: ${pick(sample[0], 'created', 'createdAt', 'createdDate')[0] ?? 'NOT FOUND'}, ticket ref: ${pick(sample[0], 'ticketId')[0] ?? (sample[0].links?.ticket ? 'links.ticket.id' : 'NOT FOUND')}, author ref: ${pick(sample[0], 'createdById', 'createdBy')[0] ?? (sample[0].links?.createdBy ? 'links.createdBy.id' : 'NOT FOUND')}, sorting by: ${sortField}`);
} else finding('shape', 'UNKNOWN', 'No communications returned.');

h('P3 · Filter type == 1 (internal notes only)');
const p3 = await call('GET', '/communication/', { query: { limit: '5', sort: `${sortField} desc`, filter: 'type == 1' } });
log(statusLine(p3));
const p3e = entities(p3.json);
log(`Returned ${p3e.length}; types seen: ${[...new Set(p3e.map((e) => e.type))].join(', ')}`);
finding('typeFilter', p3.status === 200 && p3e.every((e) => String(e.type) === '1') ? 'OK' : 'CHECK', 'type filter on /communication');

h('P4 · Filter by created timestamp (Q1 — the poller depends on this)');
const since = new Date(Date.now() - 24 * 3600e3);
const future = '2099-01-01T00:00:00';
const variants = [since.toISOString(), since.toISOString().replace(/\.\d+Z$/, 'Z'), since.toISOString().slice(0, 19), since.toISOString().slice(0, 19).replace('T', ' ')];
let createdFilterFormat = null;
for (const v of variants) {
  const r = await call('GET', '/communication/', { query: { limit: '5', sort: `${sortField} asc`, filter: `type == 1 AND created > "${v}"` } });
  const es = entities(r.json);
  const allNewer = es.every((e) => !createdOf(e) || new Date(createdOf(e)) > since);
  log(`- format "${v}": HTTP ${r.status}, ${es.length} results, all newer than cutoff: ${allNewer}${r.json?.errors ? ' ' + JSON.stringify(r.json.errors) : ''}`);
  if (r.status === 200 && allNewer) {
    const neg = await call('GET', '/communication/', { query: { limit: '5', filter: `type == 1 AND created > "${future}"` } });
    const negCount = entities(neg.json).length;
    log(`  control (created > ${future}): HTTP ${neg.status}, ${negCount} results (expect 0 — proves the filter isn't silently ignored)`);
    if (neg.status === 200 && negCount === 0) { createdFilterFormat = v; break; }
  }
}
finding('createdFilter', createdFilterFormat ? 'OK' : 'FAIL', createdFilterFormat ? `Works with format like "${createdFilterFormat}". Polling plan A is viable as designed.` : 'Could not filter communications by created — fall back to ticket.modified polling (see P7).');

h('P5 · Server-side text.Contains("!")');
const p5 = await call('GET', '/communication/', { query: { limit: '5', sort: `${sortField} desc`, filter: 'type == 1 AND text.Contains("!")' } });
const p5e = entities(p5.json);
const neg5 = await call('GET', '/communication/', { query: { limit: '5', filter: 'type == 1 AND text.Contains("zq9xq-no-such-text")' } });
log(`${statusLine(p5)} → ${p5e.length} results, all contain "!": ${p5e.every((e) => String(e.text ?? '').includes('!'))}`);
log(`control: ${statusLine(neg5)} → ${entities(neg5.json).length} results (expect 0)`);
finding('containsFilter', p5.status === 200 && entities(neg5.json).length === 0 ? 'OK' : 'CHECK', 'text.Contains on communications');

h('P6 · include=createdBy,ticket');
const p6 = await call('GET', '/communication/', { query: { limit: '1', sort: `${sortField} desc`, include: 'createdBy,ticket' } });
log(statusLine(p6));
log(`Top-level keys: ${Object.keys(p6.json || {}).join(', ')}`);
if (p6.json?.linked) log(`linked contains: ${Object.entries(p6.json.linked).map(([k, v]) => `${k}[${Array.isArray(v) ? v.length : '?'}]`).join(', ')}`);
finding('include', p6.status === 200 ? 'OK' : 'CHECK', 'include of related entities');

h('P7 · Fallback: tickets filtered by modified');
const p7 = await call('GET', '/ticket/', { query: { limit: '3', filter: `modified > "${createdFilterFormat ?? variants[2]}"` } });
log(`${statusLine(p7)} → ${entities(p7.json).length} results`);
if (entities(p7.json)[0]) log(`ticket fields: ${Object.keys(entities(p7.json)[0]).join(', ')}`);

h('Rate-limit headers seen');
log(rateHeaders.size ? [...rateHeaders].map(([k, v]) => `- ${k}: ${v}`).join('\n') : '- none exposed (Q6 must be asked to PureService support)');
findings.rateLimit = { verdict: rateHeaders.size ? 'INFO' : 'UNKNOWN', detail: rateHeaders.size ? [...rateHeaders.keys()].join(', ') : 'No rate-limit headers; per-key vs per-IP must be confirmed with support.' };

// ---------------------------------------------------------------- test ticket
let ticketId = null;
let mentionSnippet = null;
if (TEST_REQ) {
  h(`P8 · Test ticket ${TEST_REQ} — full note text (Q2 mentions, Q3 HTML)`);
  let t = await call('GET', `/ticket/${encodeURIComponent(TEST_REQ)}/requestNumber/`);
  if (t.status !== 200 || !entities(t.json)[0]) t = await call('GET', '/ticket/', { query: { filter: `requestNumber == ${Number(TEST_REQ)}` } });
  const ticket = entities(t.json)[0];
  log(statusLine(t));
  if (!ticket) log('Could not resolve the test ticket by request number.');
  else {
    ticketId = ticket.id;
    log(`Resolved request number ${TEST_REQ} → ticket id ${ticketId}`);
    let c = await call('GET', '/communication/', { query: { filter: `ticketId == ${ticketId}`, sort: `${sortField} asc`, limit: '50', include: 'createdBy' } });
    if (c.status !== 200) c = await call('GET', '/communication/', { query: { filter: `ticket.id == ${ticketId}`, sort: `${sortField} asc`, limit: '50', include: 'createdBy' } });
    log(statusLine(c));
    const comms = entities(c.json);
    const rawPath = save('test-ticket-raw.json', JSON.stringify(c.json, null, 2));
    log(`${comms.length} communications (raw JSON saved to ${rawPath ?? '(nowhere — write blocked)'})`);
    for (const e of comms) {
      log(`\n### communication ${e.id} · type ${e.type} · direction ${e.direction} · visibility ${e.visibility} · created ${createdOf(e)} · author ${authorIdOf(e)}`);
      log('```html\n' + String(e.text ?? '') + '\n```');
      const m = String(e.text ?? '').match(/<[^>]*(mention|data-(user|agent|id))[^>]*>.*?<\/[a-z]+>|<a[^>]*>@[^<]*<\/a>|<span[^>]*>@[^<]*<\/span>|\[@?[^\]]+\]\(\w+:\d+\)/i);
      if (m && !mentionSnippet) mentionSnippet = m[0];
    }
    finding('html', comms.some((e) => /<[a-z][^>]*>/i.test(String(e.text ?? ''))) ? 'YES' : 'NO', 'Note text contains HTML markup (parser must strip tags)');
    finding('mentionFormat', mentionSnippet ? 'FOUND' : 'NOT FOUND', mentionSnippet ? `Mention markup: ${mentionSnippet}` : 'No mention markup recognised — check the raw JSON by eye (did the test ticket contain an @-mention made in the UI?).');
  }
} else log('\n(PS_TEST_TICKET not set — skipping P8–P9: mentions, HTML, author, write test.)');

// ---------------------------------------------------------------- opt-in write
if (WRITE && ticketId) {
  h('P9 · Write test: one internal note on the test ticket (Q2 notification, Q4 author)');
  let text = `🤖 pureservice-tools spike test ${new Date().toISOString()} — safe to delete.`;
  if (MENTION && mentionSnippet) text += ` Mention test: ${mentionSnippet}`;
  else if (MENTION) log('--mention given but no mention markup was found on the test ticket; posting without it.');
  const body = { communications: [{ text, type: 1, direction: 3, links: { ticket: { id: ticketId } } }] };
  const w = await call('POST', '/communication/', { body });
  log(statusLine(w));
  const created = entities(w.json)[0];
  if (created) {
    const back = await call('GET', `/communication/${created.id}`, { query: { include: 'createdBy' } });
    const stored = entities(back.json)[0] ?? created;
    log(`Created communication ${created.id}; stored type=${stored.type}, direction=${stored.direction}, visibility=${stored.visibility}`);
    log('Stored text:\n```html\n' + stored.text + '\n```');
    const authorId = authorIdOf(stored);
    const author = (back.json?.linked?.users ?? []).find((u) => u.id === authorId);
    finding('author', 'INFO', `Notes created by this API key are authored by user id ${authorId}${author ? ` (${author.fullName ?? author.firstName ?? ''}, role ${author.role})` : ''}. The bot must ignore notes from this id.`);
    if (MENTION && mentionSnippet) log('\n➡ Now check: did the mentioned agent get an in-app/e-mail notification? Record the answer for Q2.');
  } else finding('write', 'FAIL', 'Could not create the internal note — see the error above.');
} else if (WRITE) log('\n--write ignored: no resolvable PS_TEST_TICKET.');

finish();

function finish() {
  h('Summary');
  for (const [q, f] of Object.entries(findings)) log(`- **${q}**: ${f.verdict} — ${f.detail}`);
  log(`\nTotal API requests made: ${requestCount}`);
  log('\nManual checks still needed (UI, not API):');
  log('- Q5: Admin → Workflow → Add: is "Communication" (or internal note) offered under "What is created"?');
  log('- Q7: Admin → Workflow → Definitions: does any enabled workflow fire on ticket update / new communication and e-mail end users?');
  const p = save('report.md', lines.join('\n') + '\n');
  console.log(p ? `\nReport written to ${p}` : '\nReport could not be saved — copy the console output instead.');
}
