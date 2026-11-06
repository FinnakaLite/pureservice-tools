// Follow-up spike: how can the poller page through "new internal notes"?
// The first spike showed `created > "<string>"` is rejected (DateTimeOffset vs String),
// i.e. the filter is parsed as a .NET (Dynamic LINQ-style) expression.
// This probe tests (a) an integer id cursor and (b) typed date expressions.
// Read-only. Prints only ids, types and timestamps — never note text.
//
//   node --env-file=spike/.env spike/cursor-probe.mjs

const rawBase = (process.env.PS_BASE_URL || '').trim().replace(/\/+$/, '');
const KEY = (process.env.PS_API_KEY || '').trim();
if (!rawBase || !KEY) { console.error('Set PS_BASE_URL and PS_API_KEY in spike/.env'); process.exit(1); }
const API = rawBase.endsWith('/agent/api') ? rawBase : `${rawBase}/agent/api`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
async function get(path, query) {
  await sleep(800);
  n++;
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  try {
    const res = await fetch(url, { headers: { 'X-Authorization-Key': KEY, Accept: 'application/vnd.api+json' }, signal: AbortSignal.timeout(20000) });
    const json = await res.json().catch(() => null);
    return { status: res.status, items: json?.communications ?? json?.tickets ?? [], errors: json?.errors };
  } catch (e) { return { status: 0, items: [], errors: [String(e)] }; }
}
const fmt = (r) => `HTTP ${r.status}, ${r.items.length} results${r.errors ? ' ' + JSON.stringify(r.errors) : ''}`;

// --- A: id cursor ------------------------------------------------------------
console.log('## A · Integer id cursor');
const latest = await get('/communication/', { limit: '50', sort: 'id desc', filter: 'type == 1' });
console.log(`latest 50 notes by id desc: ${fmt(latest)}`);
const ids = latest.items.map((e) => e.id);
if (ids.length) {
  const pivot = ids[Math.min(10, ids.length - 1)];
  const after = await get('/communication/', { limit: '50', sort: 'id asc', filter: `type == 1 AND id > ${pivot}` });
  const ok = after.items.every((e) => e.id > pivot) && after.items.length === ids.filter((i) => i > pivot).length;
  console.log(`id > ${pivot} (sort id asc): ${fmt(after)} · all ids greater: ${after.items.every((e) => e.id > pivot)} · matches expected count: ${ok}`);
  const ctrl = await get('/communication/', { limit: '5', filter: `type == 1 AND id > 999999999` });
  console.log(`control id > 999999999: ${fmt(ctrl)} (expect 0)`);
  const combo = await get('/communication/', { limit: '50', sort: 'id asc', filter: `type == 1 AND id > ${pivot} AND text.Contains("!")` });
  console.log(`id cursor + text.Contains("!"): ${fmt(combo)}`);

  // Are ids monotonic with created? (out-of-order commits would show as inversions)
  const asc = [...latest.items].sort((a, b) => a.id - b.id);
  let inversions = 0, maxBackSec = 0;
  for (let i = 1; i < asc.length; i++) {
    const d = (new Date(asc[i].created) - new Date(asc[i - 1].created)) / 1000;
    if (d < 0) { inversions++; maxBackSec = Math.max(maxBackSec, -d); }
  }
  console.log(`id vs created ordering over ${asc.length} notes: ${inversions} inversions (max ${maxBackSec.toFixed(1)} s backwards)`);
  const edited = latest.items.filter((e) => e.modified && e.created && new Date(e.modified) - new Date(e.created) > 1000);
  console.log(`notes edited after creation (modified > created + 1s): ${edited.length} of ${latest.items.length}`);
  const span = asc.length > 1 ? (new Date(asc.at(-1).created) - new Date(asc[0].created)) / 60000 : 0;
  console.log(`time span of the latest ${asc.length} internal notes: ${span.toFixed(0)} min (≈ ${(asc.length / Math.max(span, 1) * 60).toFixed(1)} notes/hour)`);
}

// --- B: typed date expressions ----------------------------------------------
console.log('\n## B · Typed date expressions');
const since = new Date(Date.now() - 6 * 3600e3);
const iso = since.toISOString().replace(/\.\d+Z$/, 'Z');
const [Y, M, D, h, m, s] = [since.getUTCFullYear(), since.getUTCMonth() + 1, since.getUTCDate(), since.getUTCHours(), since.getUTCMinutes(), since.getUTCSeconds()];
const variants = [
  `created > DateTimeOffset.Parse("${iso}")`,
  `created > DateTime.Parse("${iso}")`,
  `created > DateTime(${Y}, ${M}, ${D}, ${h}, ${m}, ${s})`,
  `created > DateTimeOffset(${Y}, ${M}, ${D}, ${h}, ${m}, ${s}, TimeSpan.Zero)`,
  `created.UtcDateTime > DateTime(${Y}, ${M}, ${D}, ${h}, ${m}, ${s})`,
];
for (const v of variants) {
  const r = await get('/communication/', { limit: '20', sort: 'id asc', filter: `type == 1 AND ${v}` });
  const allNewer = r.items.every((e) => new Date(e.created) > since);
  console.log(`- ${v}\n    ${fmt(r)} · all newer than cutoff: ${allNewer}`);
}
const tick = await get('/ticket/', { limit: '3', filter: `modified > DateTimeOffset.Parse("${iso}")` });
console.log(`- ticket: modified > DateTimeOffset.Parse(...)\n    ${fmt(tick)}`);

console.log(`\nTotal requests: ${n}`);
