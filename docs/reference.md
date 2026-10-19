# Reference

Technical reference for the bot's configuration, tools, and surface area.

## Configuration

Settings live in `config.yaml` (model, warden thresholds, codemode limits, the system prompt). Secrets live in `.env`:

| Variable          | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `SLACK_BOT_TOKEN` | Bot user OAuth token, `xoxb-…` (required)                     |
| `SLACK_APP_TOKEN` | App-level token with `connections:write`, `xapp-…` (required) |
| `MODEL_API_KEY`   | Key for the model gateway (required)                          |

Environment variables override `config.yaml` where noted in `.env.example`: `MODEL_ID`, `WARDEN_URL`, `WARDEN_MODEL`, `WARDEN_HOLD_SCORE`, `WARDEN_INJECTION_SCORE`, `CODEMODE_MEMORY_MB`.

## Tools offered to the model

| Tool         | Source                       | Purpose                                                                                     |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------------- |
| `jira`       | `src/extensions/jira.ts`     | Runs `acli` commands; read-only by convention, gated by the warden                          |
| `skill`      | `src/extensions/skills.ts`   | Loads a skill's `SKILL.md` or a supporting file inside its directory                        |
| `run_script` | `src/extensions/skills.ts`   | Runs a skill's bundled script (`.py`/`.js`/`.sh`), scoped to the skill directory, 120 s cap |
| `codemode`   | `src/extensions/codemode.ts` | Model-written JavaScript in a QuickJS sandbox, calling the other tools; crash-safe replay   |

There is no general shell tool, by design: the model can run reviewed scripts from skill directories and nothing else.

## The warden (`src/extensions/warden.ts`)

Before every tool call:

1. **Ask gate** — an offline floor vouching `false` (read-only) passes with no classifier request.
2. **Approval window** — a recent in-thread approval passes.
3. **Classifier score** — the local System One classifier scores the call; at or above `WARDEN_HOLD_SCORE` the call is blocked with write-gate instructions.
4. **Offline floor** — when the classifier is unreachable, write-shaped calls hold and unknown tools hold (fail closed).

After every tool call, the result text is scored for prompt injection; at or above `WARDEN_INJECTION_SCORE` it is wrapped as untrusted data before the model sees it.

## Slack app surface

`manifest.yml` is the source of truth. Scopes: `app_mentions:read`, `chat:write`, `channels:history`, `users:write`. Events: `app_mention` over Socket Mode. `always_online: true` plus `users.setPresence` (`auto` on start, `away` on shutdown) is the presence indicator — the green bubble cannot track a Socket Mode connection by itself.

## Storage

- `data/session.sqlite` — all durable state: conversations, entries, tool results, thread map (`app.slack_threads`), warden approvals (`app.warden`). One process at a time (PID lockfile `data/bot.lock`).
- `.agents/skills/` — project skills (gitignored checkouts of skills packs live here), scanned alongside `~/.agents/skills`.

## npm scripts

| Script                                    | Purpose                                                     |
| ----------------------------------------- | ----------------------------------------------------------- |
| `pnpm dev` / `pnpm start`                 | Run the bot (`node src/index.ts`; TypeScript runs natively) |
| `pnpm check`                              | oxlint (type-aware, via tsgolint) + oxfmt + vitest          |
| `pnpm lint` / `pnpm format` / `pnpm test` | The individual checks                                       |

## Key source files

| File              | Role                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `src/index.ts`    | Entry point: lockfile, Harness open + resume, Slack start, presence  |
| `src/harness.ts`  | Model gateway provider, extension discovery, thread→conversation map |
| `src/slack.ts`    | Bolt relay: mention handler, reconcile, steer, streaming placeholder |
| `src/extensions/` | One file per extension, default-exported, auto-installed             |
| `src/config.ts`   | All env-driven configuration                                         |
| `src/util.ts`     | Pure helpers (answer extraction, status lines, email linkifying)     |
