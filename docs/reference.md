# Reference

Technical reference for the bot's configuration, tools, and surface area.

## Configuration

Settings live in `config.yaml` (model, warden thresholds, codemode limits, the system prompt). Secrets live in `.env`:

| Variable          | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `SLACK_BOT_TOKEN` | Bot user OAuth token, `xoxb-…` (required)                     |
| `SLACK_APP_TOKEN` | App-level token with `connections:write`, `xapp-…` (required) |
| `MODEL_API_KEY`   | Key for the model gateway (required)                          |

Environment variables override `config.yaml` where noted in `.env.example`: `MODEL_ID`, `WARDEN_BACKEND`, `WARDEN_URL`, `WARDEN_MODEL`, `WARDEN_HOLD_SCORE`, `WARDEN_INJECTION_SCORE`, `CODEMODE_MEMORY_MB`; `WARDEN_API_KEY` supplies the key for remote classifier backends.

## Tools offered to the model

| Tool                         | Source                       | Purpose                                                                                   |
| ---------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| `jira`                       | `src/extensions/jira.ts`     | Runs `acli` commands; read-only by convention, gated by the warden                        |
| `skill`                      | `src/extensions/skills.ts`   | Loads a skill's `SKILL.md` or a supporting file inside its directory                      |
| `bash`/`read`/`write`/`edit` | `src/extensions/shell.ts`    | pi-durable's coding tools via the Node execution env: journaled, crash-safe, replayable   |
| `remember`/`recall`          | `src/extensions/memory.ts`   | Shared team memory (LRU, indexed by issue keys)                                           |
| `codemode`                   | `src/extensions/codemode.ts` | Model-written JavaScript in a QuickJS sandbox, calling the other tools; crash-safe replay |

The coding tools are general-purpose by design (skill scripts run through `bash`), and the warden is the security boundary: every coding-tool call is classified, none has a read-only shortcut, and secret files (`.env`, `data/`, `.git`) are hard-denied before classification — they never enter model context, even with an approval.

## The warden (`src/extensions/warden.ts`)

The judge is any System One-shaped classifier, chosen in `warden.classifier.backend`:

- `llama-cpp` — a local llama-server; `url` is the server root, no key.
- `openai` — an OpenAI-compatible Decisions endpoint; `url` is the API base including `/v1`, needs `WARDEN_API_KEY`.
- `jev` — Typesafe Jev; `url` is the API base including `/v1`, needs `WARDEN_API_KEY`.

Backends are a table (`CLASSIFIER_BACKENDS` in warden.ts): wire api, URL derivation, lazy loader. Adding one is a row; nothing else in the warden knows which is configured.

Before every tool call, in order:

1. **Secret deny** — a `read` of credentials or durable state (`.env*`, `data/`, `.git/`, `bot.log`, `session.sqlite`), or a `bash` command obviously referencing them, is blocked outright. Approval cannot override this.
2. **Granted approval** — a call matching the exact (tool, arguments) of a granted approval passes once; the grant is consumed.
3. **Ask gate** — an offline floor vouching `false` (read-only) passes with no classifier request. The coding tools never vouch.
4. **Classifier score** — the local System One classifier scores the call; at or above `WARDEN_HOLD_SCORE` the call is blocked with write-gate instructions that include a four-character approval code.
5. **Offline floor** — when the classifier is unreachable, write-shaped calls hold and unknown tools hold (fail closed).

A held call is approved by the user who requested it, replying `approve <code>` in the thread (mentioning the bot). The grant matches only that exact call, is single-use, and expires after `warden.approval_window_ms`. Saying "yes" or "go ahead" alone opens nothing.

After every tool call, the result text is scored for prompt injection; at or above `WARDEN_INJECTION_SCORE` it is wrapped as untrusted data before the model sees it.

## Slack app surface

`manifest.yml` is the source of truth. Scopes: `app_mentions:read`, `chat:write`, `channels:history`, `users:write`. Events: `app_mention` over Socket Mode. `always_online: true` plus `users.setPresence` (`auto` on start, `away` on shutdown) is the presence indicator — the green bubble cannot track a Socket Mode connection by itself.

## Storage

- `data/session.sqlite` — all durable state: conversations, entries, tool results, thread map (`app.slack_threads`), thread index (`app.thread_index`), channel watermarks (`app.channels`), schedules (`app.schedules`), team memory (`app.memory`). One process at a time (PID lockfile `data/bot.lock`).
- `.agents/skills/` — project skills (gitignored checkouts of skills packs live here), scanned alongside `~/.agents/skills`.

## npm scripts

| Script                                    | Purpose                                                     |
| ----------------------------------------- | ----------------------------------------------------------- |
| `pnpm dev` / `pnpm start`                 | Run the bot (`node src/index.ts`; TypeScript runs natively) |
| `pnpm check`                              | oxlint (type-aware, via tsgolint) + oxfmt + vitest          |
| `pnpm lint` / `pnpm format` / `pnpm test` | The individual checks                                       |

## Key source files

| File               | Role                                                                                |
| ------------------ | ----------------------------------------------------------------------------------- |
| `src/index.ts`     | Entry point: lockfile, Harness open + resume, recovery sweep, Slack start, presence |
| `src/harness.ts`   | Model gateway provider, extension discovery, channel watermarks                     |
| `src/threads.ts`   | Thread→conversation map, recovery cursors, retirement (thread state)                |
| `src/turn.ts`      | One agent turn + mention normalization (runTurn / runMention)                       |
| `src/slack.ts`     | Bolt relay: mention handler, reconcile, steer, streaming placeholder                |
| `src/recovery.ts`  | Startup sweep: channel history + thread replies since watermarks/cursors            |
| `src/schedules.ts` | Configured daily prompts, claim-first, plus thread retirement tick                  |
| `src/extensions/`  | One file per extension, default-exported, auto-installed                            |
| `src/config.ts`    | All env-driven configuration                                                        |
| `src/util.ts`      | Pure helpers (answer extraction, status lines, email linkifying)                    |
