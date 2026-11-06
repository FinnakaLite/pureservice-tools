# PureService bot: architecture proposal

Status: draft for review, 2026-11-06. Nothing is built yet. API spike results
are in §9. Everything needed for polling (option A) and mentions is verified.

The goal is a bot that watches internal notes in PureService for commands like
`!remindme 10d 08:00 call supplier back`. It acts on them, for example by posting
an internal note that tags the author when the time comes. New commands should be
easy to add.

---

## 1. What the API gives us (and what it doesn't)

Sources: the official guide at <https://api-docs.pureservice.com/>, the
PureService admin manual (manula.com), and the community PowerShell module
`NN.Pureservice`, which shows the real payload shapes.

| Fact | Consequence for the design |
|---|---|
| Base URL `https://{customer}.pureservice.com/agent/api/`, JSON:API (`Accept: application/vnd.api+json`) | One thin HTTP client wraps all of this. |
| Auth: `X-Authorization-Key` header, keys under *Administration → Security → API keys*, optional expiry | Use a dedicated key with an expiry date, stored as a secret, and rotate it. Bearer tokens are being deprecated, so we don't use them. |
| **Rate limit: 100 requests/min per client.** A 429 response may include `Retry-After` | The client gets a hard budget well under 100 (see §4) and always honours 429s. |
| Max 500 entities per request; paging with `start` and `limit` | The poller pages in small batches. |
| Filtering with `filter=` (`==`, `>`, `<`, `.Contains()`, `AND`, `OR`), `sort=field asc`, `include=`. **Verified in the spike:** the filter is a typed .NET expression. Dates must be `DateTimeOffset.Parse("…")`; plain strings are rejected. `id > N`, `type == 1`, `text.Contains("!")` and `include=createdBy` all work | We can ask the server for only *new internal notes*, so polling stays cheap. |
| Internal notes are `communication` entities. `type`: 1 = Note, 2 = Message (**emails the end user**), 3 = SMS, 4 = Solution… `direction`: 1 = Inbound, 2 = Outbound, 3 = None | Read only `type == 1`. Write only `type 1, direction 3`. The bot never creates type 2. |
| Creating a note: `POST /communication` with `{"communications":[{"text":…,"type":1,"direction":3,"links":{"ticket":{"id":…}}}]}` | This becomes the bot's single write path. |
| The API is labelled beta/"public preview", and PureService doesn't support custom solutions built on it | All PureService-specific code lives in one module, so API changes stay contained. We pin to known behaviour with tests. |
| **No webhook subscription API.** The *workflow builder* can run on "Something is created → <entity>" with criteria, and can do **HTTP POST/PUT** as an action | Push is possible, but only through an admin-configured workflow, and only if "Communication" is a choice in the "What is created" dropdown. That's unverified. |
| @-mentions exist in notes, but only agents in the ticket's zone can be mentioned. A mention gives an in-app notification and, optionally, an email. **Verified:** a mention is stored as `<a class="x-ps-autocomplete-mention" href="mailto:{email}" data-mention="true" data-mention-user-id="{id}" data-mention-firstname="…" data-mention-lastname="…">@Full Name</a>` | The bot can build a mention from the author's user id, email and name (one cached user lookup). **Verified:** an API-posted mention sends a real notification (§9). |
| **Verified:** note `text` is HTML (`<p>…</p>`) | Before parsing, strip tags, turn `<p>`/`<br>`/`<div>` into line breaks, decode entities (`&nbsp;`, `&amp;`), and drop mention anchors. |

---

## 2. How to detect notes that call the bot

I looked at three options.

### Option A: Polling the API (recommended as the base)

Every 30 s, the bot asks for new internal notes after the last note id it has seen.
Note ids are increasing integers; the spike found 0 ordering inversions against
`created` over 50 notes.

```
GET /agent/api/communication/
    ?filter=type == 1 AND id > 562662 AND text.Contains("!")
    &sort=id asc
    &limit=100
    &include=createdBy
```

All parts of this query were verified in the spike. `text.Contains("!")` keeps
responses tiny. `include=createdBy` returns the author's name and email in
`linked.users`, so a mention needs no extra request. A date cursor also works
(`created > DateTimeOffset.Parse("…Z")`), but an integer cursor has no clock or
time zone edge cases.

- Costs about 2 requests/min, which is 2 % of the rate limit.
- Needs **only outbound HTTPS**: no public endpoint, no firewall opening, and no
  PureService admin configuration.
- If the bot is down, it catches up from the saved cursor, so nothing is lost.
- Downside: up to about 30 s latency. For reminders measured in minutes or days,
  that doesn't matter.

Correctness details:
- **The cursor overlaps.** Each poll asks for `id > cursor − 50`, because a
  transaction with a lower id could commit slightly after a higher one.
  Duplicates are removed by communication id (§5), so the overlap is free.
- Observed volume: about 50 internal notes in 50 hours that the key can see, so
  load is negligible. Note that the bot only sees tickets in the zones the API
  key's user has access to.

### Option B: Workflow → HTTP POST push (optional later add-on)

An admin builds a workflow: *Something is created → Communication*, criteria
*type is internal note* AND *text contains "!"*, action *HTTP POST* to
`https://<bot>/hooks/pureservice` with a secret header.

- Near-instant, with zero polling.
- **Requires a public HTTPS endpoint** that PureService SaaS can reach, plus a
  shared secret and IP allowlisting.
- Workflows can silently stop firing (disabled, changed by an admin, beta
  feature), so **polling still runs as a safety net** at a slower interval
  (e.g. every 5 min).
- The webhook body is treated as a hint only: the bot re-fetches the
  communication by id through the API before acting.

### Option C: Email or mention tricks (rejected)

Ideas like having the bot mentioned so it gets an email, then reading that
mailbox. These are fragile, add a mailbox to secure, and give nothing that
polling doesn't.

**Decision: start with A. Add B later only if 30 s of latency ever matters.**
Both feed the same internal event (`NoteCreated`), so switching costs nothing.

---

## 3. Architecture

```
                ┌──────────────────────── bot process (single instance) ───────────────────────┐
                │                                                                               │
 PureService ◄──┤  PureServiceClient  (token bucket, 429/Retry-After, backoff, circuit breaker)  │
   API          │        ▲                    ▲                          ▲                       │
                │        │ read               │ read                     │ write (internal note) │
                │  ┌─────┴─────┐       ┌──────┴──────┐            ┌──────┴──────┐                │
                │  │  Poller   │       │  Webhook rx │ (phase 2)  │   Replier   │◄── only write  │
                │  └─────┬─────┘       └──────┬──────┘            └──────▲──────┘    path        │
                │        └──── NoteCreated ───┘                          │                       │
                │                 ▼                                      │                       │
                │          ┌─────────────┐  guards: own note? dup?       │                       │
                │          │ Dispatcher  │  command at line start? kill  │                       │
                │          └──────┬──────┘  switch? budgets?             │                       │
                │                 ▼                                      │                       │
                │        ┌──────────────────┐   ctx.reply() ─────────────┤                       │
                │        │ Command registry │   ctx.schedule() ──┐       │                       │
                │        │  !remindme  !help│                    ▼       │                       │
                │        │  !reminders ...  │             ┌────────────┐ │                       │
                │        └──────────────────┘             │ Scheduler  │─┘ due jobs → handlers   │
                │                                         └─────┬──────┘                         │
                │                                               ▼                                │
                │                                   SQLite (jobs, processed, cursor, audit)      │
                └───────────────────────────────────────────────────────────────────────────────┘
```

**Stack (as built):** TypeScript run directly by Node 24, with no build step.
- Luxon for time zones. Everything is computed in `Europe/Oslo` and stored in UTC.
- SQLite via the built-in `node:sqlite`, using WAL mode.
- Tests use the built-in `node:test`.
- Shipped as one Docker image. The only runtime dependency is `luxon`.

### Plugin model: adding a command = adding one folder

```ts
// src/commands/remindme/index.ts
export default defineCommand({
  name: 'remindme',
  aliases: ['påminn', 'remind'],
  summary: 'Tag me on this ticket later',
  usage: '!remindme <when> [message]   e.g. !remindme 10d 08:00 ring leverandør',
  limits: { perUserPerHour: 20, maxActivePerUser: 100 },
  async run(ctx, args) {
    const when = parseWhen(args, ctx.now);          // pure function, heavily unit-tested
    if (!when.ok) return ctx.reply(when.error);     // one help reply, never more
    const id = await ctx.schedule('remindme.fire', when.at, {
      message: when.rest, userId: ctx.note.authorId,
    });
    await ctx.reply(`⏰ Reminder ${id} set for ${fmt(when.at)}.`);
  },
});

// src/commands/remindme/fire.ts
export default defineJob('remindme.fire', async (ctx, p) => {
  await ctx.reply(`🔔 ${ctx.mention(p.userId)} reminder: ${p.message ?? '(no text)'}`);
});
```

What the context gives a command: the note (`ticketId`, `authorId`, `text`,
`createdAt`), `ticket()` (lazy and cached), `reply()`, `schedule()`, `cancel()`, a
small key/value `store`, `log`, and `now`. Commands never see the raw HTTP client,
so they can't bypass the safety rules.

A generic `jobs` table with a `type` column means future commands reuse the
scheduler for free. Examples: `!followup` reopening a ticket on a date,
`!snooze`, or `!escalate` if a ticket is untouched after N hours.

### Proposed layout

```
src/
  core/
    pureservice/   client.ts (rate limit, retry), communications.ts, tickets.ts, users.ts
    ingest/        poller.ts, webhook.ts (later)
    dispatcher.ts  registry.ts  scheduler.ts  replier.ts
    safety/        budgets.ts, circuit-breaker.ts, killswitch.ts
    store/         db.ts, migrations/
  commands/
    help/
    remindme/      index.ts, parse.ts, parse.test.ts, fire.ts, list.ts, cancel.ts
  config.ts  main.ts
test/fixtures/     recorded PureService responses for integration tests
Dockerfile
```

---

## 4. Not overloading PureService

All traffic goes through **one client with one token bucket**. No other code makes
HTTP calls.

| Budget | Value | Why |
|---|---|---|
| Hard client ceiling | **40 req/min** (40 % of the limit) | Leaves headroom in case "per client" means per IP or tenant and is shared with other integrations. |
| Poller | 1 request every 30 s, plus paging only during catch-up (max 10 pages/min) | Normal load ≈ 2 req/min. |
| Writes (bot notes) | ≤ 20/min globally | A burst of 08:00 Monday reminders gets spread over a few minutes. |
| Lookups (user names, ticket zone) | Cached for 1 h | Removes repeated reads. |

Behaviour:
- **On 429:** sleep for `Retry-After`, or exponential backoff with jitter if it's
  missing, and pause the whole bucket, not just one request.
- **On 5xx or timeouts:** retry at most 3 times with backoff. After repeated
  failures, the circuit breaker opens: the bot stops calling for 5 min and logs
  an alert.
- Request timeout is 15 s, with a single in-flight poll at a time (no
  overlapping polls).
- On restart, the bot resumes from the cursor but **never backfills history from
  before its first start.** On first boot the cursor is set to "now", so old
  `!remindme`s from 2023 aren't all executed at once.

---

## 5. Not spamming, not replying to things not meant for it

Each rule below is a hard guard in the dispatcher or replier, not a convention:

1. **Only internal notes trigger it** (`type == 1`). Messages to end users,
   descriptions and solutions are ignored entirely.
2. **The command must start a line** and match `^!(\w+)` exactly against a
   registered name or alias. `Remember !remindme is cool` and `!!!` do nothing.
   Code and quoted blocks are stripped first, so a pasted bot reply can't trigger
   anything.
3. **Unknown `!words` are ignored silently.** Only a *known* command with bad
   arguments gets one short usage reply.
4. **Notes written by the bot's own user are always ignored**, so the bot can't
   loop. As a second layer, bot output never starts with `!` and carries a
   `🤖` prefix.
5. **Each note is processed at most once.** `processed_notes(communication_id
   PRIMARY KEY)` is inserted *before* the handler runs, in the same transaction
   as any jobs it schedules. Edits to an old note don't re-trigger it.
6. **The bot can only post internal notes.** `replier.ts` hard-codes `type: 1,
   direction: 3`. No code path in the bot can create a Message, which would email
   the customer.
7. **There's one post per reminder, even across crashes.** Jobs move `pending →
   sending → sent`. Each bot note carries a short reference (e.g. `ref R-0042`).
   If a POST times out, the bot first checks the ticket's notes for that ref
   before retrying, so a lost response doesn't cause a duplicate.
8. **Budgets and breakers:**
   - max 5 bot notes per ticket per hour
   - max 20 commands per user per hour
   - max 100 active reminders per user
   - global ≤ 20 notes/min

   Exceeding a global budget **pauses writing and alerts** rather than queueing
   endlessly.
9. **Late reminders are handled.** If the bot was down and a reminder is more
   than 1 h late, it fires once with "(delayed, was due …)". Several overdue
   reminders on one ticket are combined into one note.
10. **There's a kill switch:** an env flag `BOT_WRITE_ENABLED=false`, which turns
    on dry-run mode. In dry-run, everything is parsed and logged but nothing is
    posted.
11. **Rollout is gradual:** start in dry-run, then live for an allowlist (the IT
    zone or named agents), then everyone.
12. **Existing workflows need checking.** A bot note is a ticket update, so we
    verify that no existing PureService workflow (e.g. "ticket updated → email
    user") fires on internal notes from the bot.

---

## 6. `!remindme` syntax

```
!remindme <when> [message]
```

`<when>` can be any of:

- **One or more durations**, optionally followed by a time of day:
  `10d`, `10m`, `1month`, `2h30m`, `1w 2d`, `3 dager`, `10d 8:00`
- **A time of day alone**, meaning its next occurrence: `08:00`, `0800`, `08.00`,
  `kl 8`, `at 8`
- **A date**, optionally followed by a time of day:
  - `24.12`, `24.12.2026`, `2026-12-24`
  - `imorgen` / `tomorrow`, `fredag` / `friday` (next one)
  - examples: `24.12 kl 9`, `fredag 14:30`

| Unit | Accepted forms (English + Norwegian, case-insensitive) |
|---|---|
| minutes | `m`, `min`, `mins`, `minute(s)`, `minutt(er)` |
| hours | `h`, `t`, `hr`, `hour(s)`, `time(r)` |
| days | `d`, `day(s)`, `dag(er)` |
| weeks | `w`, `u`, `wk`, `week(s)`, `uke(r)` |
| months | `mo`, `mnd`, `month(s)`, `måned(er)` |
| years | `y`, `år`, `year(s)` |

Rules:
- `m` always means **minutes**, the Reddit convention. Months are
  `mo`/`mnd`/`month`.
- A time is `H:MM`, `HH:MM`, `HH.MM`, a 4-digit `HHMM`, or `kl`/`at` + `H`. A bare
  `8` with no `kl`, `at` or colon is treated as message text, not a time, so
  `!remindme 2d 3 boxes missing` works.
- Durations use calendar arithmetic in Europe/Oslo. That means `1d` across a
  daylight-saving change still lands on the same clock time, and 31 Jan + 1 month
  = 28/29 Feb.
- Duration + time: add the duration, then set the clock. So `10d 08:00` means
  08:00 on the day ten days from now.
- A time alone means today if it's still ahead, otherwise tomorrow.
- Limits: at least 1 minute, at most 2 years. A result in the past is an error.
- The confirmation reply always shows the **absolute** time the bot understood,
  so any misreading is visible straight away:
  `⏰ R-0042: fre 16.11.2026 kl 08:00`.
- Companion commands:
  - `!reminders` lists your active reminders on this ticket.
  - `!remindme cancel R-0042` cancels one.
  - `!help` lists the registered commands from the registry.

The parser is a pure function `(text, now) → result`, covered by a large table of
test cases. Those include DST transitions, month ends, Norwegian and English input
and garbage input.

Open UX choice: whether the confirmation note should be optional per user. For
now it's on, because silent failures are worse than one extra note.

---

## 7. Storage

**SQLite** in a single file on a persistent volume, WAL mode, nightly backup.
It's behind a small repository interface, so it can move to Azure SQL or Postgres
if we ever need more than one instance.

```sql
state            (key TEXT PRIMARY KEY, value TEXT)          -- poll cursor, schema version
processed_notes  (communication_id INTEGER PRIMARY KEY, ticket_id, command, outcome, processed_at)
jobs             (id TEXT PRIMARY KEY,           -- R-0042
                  type TEXT,                     -- 'remindme.fire'
                  run_at TEXT,                   -- UTC ISO
                  status TEXT,                   -- pending|sending|sent|failed|cancelled
                  payload TEXT,                  -- JSON (message, userId)
                  ticket_id INTEGER, created_by INTEGER, source_communication_id INTEGER,
                  attempts INTEGER, last_error TEXT, created_at, updated_at)
audit_log        (ts, action, ticket_id, user_id, job_id, detail)   -- no note bodies
```

- The scheduler loop wakes every 15 s and runs
  `SELECT … WHERE status='pending' AND run_at <= now ORDER BY run_at LIMIT 20`.
  It claims rows atomically before acting.
- **Only one instance runs at a time.** A lock row in `state` with a heartbeat
  prevents two copies from double-processing.
- **Data is kept to a minimum.** The bot stores ids and the reminder's own message
  text, never full note bodies. `processed_notes` and `audit_log` are purged after
  90 days, and sent jobs after 1 year. Logs never contain note text. This keeps us
  in line with E.A. Smith's information-governance rules, since ticket notes can
  contain personal data. The bot runs entirely on our own infrastructure, with no
  AI and no third parties.

---

## 8. Hosting

Polling needs only outbound HTTPS, so hosting is simple:

| Option | Pros | Cons |
|---|---|---|
| **1. Docker container on an existing internal Linux/Windows server or VM** (recommended for pilot) | No inbound firewall rules, cheap, fast to set up | Patching and uptime are on us. Backups must be arranged. |
| 2. Azure Container Apps, 1 fixed replica + Azure Files or Azure SQL | Managed, easy restarts, Key Vault for the API key, and a public HTTPS endpoint if we add webhooks | Needs an Azure subscription/owner. SQLite on Azure Files is meh, so use Azure SQL there. |
| 3. Azure Functions with a timer trigger | Pay per use | Awkward for a long-lived scheduler and locks. Not worth it at this scale. |

Recommendation: build it as a container from day one, pilot on option 1, and move
to option 2 if it becomes a team service or we add webhooks.

Operations:
- `/healthz` endpoint, structured JSON logs, and a heartbeat in the DB.
- An alert (email or Teams) if polling has failed for more than 5 min or the
  circuit breaker opens.
- Metrics: poll lag, notes seen, commands run, reminders fired.
- **API key:** a dedicated key, ideally tied to a dedicated agent user such as
  "PureService Bot", so notes show a clear author and the bot can recognise its
  own notes. It gets an expiry date and lives in a secret store, never in git.

---

## 9. Spike results (2026-11-06)

Scripts: `spike/probe.mjs`, `spike/cursor-probe.mjs`. Both are read-only unless
`--write` is passed.

| # | Question | Result |
|---|---|---|
| 1 | Communication fields and filtering | ✅ `id`, `type`, `typeName`, `direction`, `visibility`, `text`, `ticketId`, `createdById`, `modifiedById`, `created`, `modified` (ISO with offset), `isPinned`, `isAiGenerated`, `links.*`. Response key `communications`, and `linked.users` / `linked.tickets` with `include`. `type == 1`, `id > N`, `text.Contains()`, `ticketId == N` and `DateTimeOffset.Parse()` comparisons work. Plain date strings, `DateTime(...)` and `.UtcDateTime` don't (400/500). |
| 2a | Mention format | ✅ `<a class="x-ps-autocomplete-mention" href="mailto:…" data-mention="true" data-mention-user-id="…" data-mention-firstname="…" data-mention-lastname="…">@Name</a>` |
| 2b | Does an API-posted mention notify? | ✅ **Yes.** Posting the mention markup via `POST /communication` (type 1, direction 3) triggered a real notification for the mentioned agent, and it renders as a mention chip in the UI. Emoji (🤖) render too. |
| 3 | Is the text HTML? | ✅ Yes, `<p>` wrapped. |
| 4 | Author of API-created notes | ✅ The API key's own user. For the spike that was user 2695 "Pureservice-tools-test", role 50 (System), which is shown as the note author in the UI. **The production key should get its own clearly named user**, e.g. "PureService Bot". The bot ignores notes whose `createdById` is that user. POST returns HTTP 201 with the created entity, including `id`. |
| 5 | Workflow trigger on communication | ⏳ Manual check in the admin UI. Only matters for option B. |
| 6 | Rate limit per key or per IP | ❓ No rate-limit headers are exposed. Ask PureService support. The 40/min ceiling covers either case. |
| 7 | Do existing workflows fire on notes? | ⏳ Manual check in the admin UI. |
| – | Ticket lookup by request number | ✅ `GET /ticket/{requestNumber}/requestNumber/` |
| – | Note edits | 0 of 50 recent notes were edited after creation. We still never re-run edited notes. |

**Dev environment note:** Windows (most likely Defender "Controlled folder access")
blocks `node.exe` from writing under `Documents`. The project now lives in
`Desktop\GitHub\pureservice-tools`.

## 10. Phases

| Phase | Content | Done when |
|---|---|---|
| 0. Spike | Items in §9, recorded API fixtures | ✅ Done for option A. Remaining: 5 and 7 (admin UI checks), 6 (ask support) |
| 1. Core + `!remindme` | Client, poller, dispatcher, registry, scheduler, SQLite, parser + tests, `!help`, `!reminders`, cancel | 🟡 Built 2026-11-06: 97 tests pass, and a short dry run against prod handled a real note correctly. Next: run in dry-run for a week |
| 2. Pilot | Writes enabled for an allowlist (IT zone) | Reminders fire on time, with no duplicates and no stray notes |
| 3. General | All agents, alerting, backups, runbook | Running unattended |
| 4. More commands | e.g. `!followup`, `!snooze`, `!escalate`, `!assign` | Each is one folder + tests |
