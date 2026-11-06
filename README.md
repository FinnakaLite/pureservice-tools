# pureservice-tools

A bot for PureService that reacts to `!commands` written at the start of a line in
**internal notes**. The first command is `!remindme`: the bot tags you on the ticket
at a later time.

```
!remindme 10d                    in 10 days
!remindme 10d 08:00              10 days from now at 08:00 (also 0800, 08.00, kl 8)
!remindme 2t30m sjekk backup     in 2 h 30 min, with a message
!remindme fredag kl 9            next Friday at 09:00
!remindme 24.12                  24 December at 08:00
!reminders                       your active reminders on this ticket
!remindme cancel R-12            cancel one
!help                            list all commands
```

Units: `m`/`min` minutes · `h`/`t`/`timer` hours · `d`/`dager` days · `w`/`u`/`uker`
weeks · `mo`/`mnd`/`month` months · `y`/`år` years. `m` always means **minutes**.

## Run it with Docker (recommended)

Requires Docker with the Compose plugin. Every setting is in
[docker-compose.yml](docker-compose.yml) except the API key, which comes from a
git-ignored `.env` file next to it.

```bash
git clone <repo-url> pureservice-tools && cd pureservice-tools
echo PS_API_KEY=your-key > .env
docker compose up -d --build
```

The same `docker compose up -d --build` command also applies updates after a
`git pull`. Useful commands:

```bash
docker compose logs -f             # follow the JSON logs
curl http://127.0.0.1:8080/healthz # status: last poll, cursor, pending reminders
docker compose down                # stop (reminders are kept in the bot-data volume)
```

The bot starts in **dry-run**, with only user 2611 allowed. To go live, set
`BOT_WRITE_ENABLED: "true"` in the compose file (and widen or clear
`BOT_ALLOWED_USER_IDS`), then run `docker compose up -d` again.

Reminders live in the named volume `bot-data`. `docker compose down -v` **deletes
them**.

## Run it with Node

Requires Node 24+. No build step: Node runs the TypeScript directly.

```bash
npm install
cp .env.example .env      # then fill in PS_API_KEY
npm start                 # starts in DRY-RUN: logs what it would post, posts nothing
npm run verify            # type-check + tests
```

Set `BOT_WRITE_ENABLED=true` to let it post. Start with `BOT_ALLOWED_USER_IDS` set to
a few pilot users. `GET http://127.0.0.1:8080/healthz` reports status.

Run **one instance per database**. A lock in the database stops a second copy from
starting. Don't put the project under `Documents` on this machine: Windows blocks
`node.exe` from writing there.

## Add a command

1. Create `src/commands/<name>/index.ts` that exports `defineCommand({ name, summary, usage, run(ctx, args) })`.
   If it needs to act later, also export a job with `defineJob({ type, run(ctx) })` and use `ctx.schedule(...)`.
2. Register it in `src/commands/index.ts`.
3. Add tests next to it.

A command can only use its `ctx`:
- `reply(html)`
- `schedule(type, at, payload)`
- `cancelJob(id)`
- read-only `jobs` queries

It never gets the HTTP client. Rate limits, dry-run, budgets and duplicate protection
therefore apply to every command automatically.

## How it works

See [docs/PROPOSAL.md](docs/PROPOSAL.md) for the design and the API spike results.
In short:

- **Poller:** reads new internal notes containing `!` every 30 s, using an id cursor.
- **Dispatcher:** applies the guards: notes by the bot itself and system users are
  ignored, only registered commands at line start count, and there's an allowlist
  and per-user limits.
- **Commands:** they don't write directly. Their effects are committed atomically
  with the "processed" marker.
- **Scheduler:** runs due jobs.
- **Outbox:** posts internal notes within budgets, with a hidden marker so an
  uncertain send is never duplicated.
- **Storage:** SQLite in `data/bot.db`.
