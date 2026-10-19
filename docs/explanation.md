# Explanation: how the bot works

Why the bot is built the way it is. For steps, see `docs/how-to.md`; for facts, `docs/reference.md`.

## pi-durable is the harness; Slack is a wire

Every Slack thread maps to one durable conversation. When you `@triage`, the handler:

1. Resolves (or creates) the conversation for that thread — creation and the thread→conversation mapping commit atomically in a session-scoped document family.
2. Pulls any thread messages unseen since the bot's last reply (`conversations.replies`, tracked by `lastSeenTs`) into the conversation as context-only writes.
3. Submits your text as an input and waits for the settled answer, streaming progress into a placeholder message that the final answer replaces.

The model, tools, and transcripts all live in the Harness. If the process dies mid-answer, reopening the SQLite storage resumes the run from its last commit. This is why the bot uses `@earendil-works/pi-durable` instead of shelling out to `pi`: the agent state is a database, not a process.

**Pull, not push.** Non-mention thread replies are never received as events. They are fetched at the next ping. This means no event subscription beyond `app_mention`, no missed messages while the bot was down, and — the intended workflow — teammates can discuss in a thread for hours before pinging the bot, which then sees the whole discussion.

**Steering, not queueing.** A ping that arrives while the bot is already thinking joins the running work (`whenBusy: "steer"`), carrying any unseen thread messages with it, so a mid-stream correction changes the answer in flight. Only pings steer; plain replies never trigger anything.

## Extensions are discovered, not registered

Every `src/extensions/*.ts` module default-exports an Extension and is installed at startup. Conversations enable every registered tool by default, so adding a capability is dropping in a file — no registry list, no tool list, nothing to forget to update. The same convention carries the warden's offline floors: the extension that owns a tool also owns its read/write opinion, so the warden never names tools it doesn't know. An unknown tool with no floor fails closed (holds) when the classifier is unreachable.

## The write gate and the warden

The bot's system prompt states a discipline borrowed from the skills pack the bot consumes: before anything that writes (Jira updates, PRs, comments), state the target, the exact command, and the failure mode in the thread, then wait for approval. That is prose, and prose can be ignored — so the warden enforces it mechanically.

The warden is a pi-warden-style action guard judged by a local classifier instead of a hosted one (a llama.cpp System One model on `127.0.0.1:18080`). Before each tool call it scores the risk; above the threshold the call is blocked with instructions to follow the write gate. A human approval in the thread opens a short window during which the held call passes. Read-only calls skip the classifier entirely via the offline floors (pi-warden's "ask gate"), so the guard adds no latency to the common path. After each call, tool output is scored for prompt injection — Jira issue text is untrusted input, and a hostile description saying "ignore your rules" gets framed as data rather than obeyed.

Fail-closed is the load-bearing choice: when the classifier is down, write-shaped calls hold and unknown tools hold. A guard that fails open is a guard that is off exactly when you stopped checking it.

## Why there is no shell

The bot answers to anyone who can mention it, and it runs on a machine where `acli`, `gh`, and friends are authenticated. An LLM with a shell there is a trust-boundary hole. The model instead gets: `jira` (the CLI, gated), `skill`/`run_script` (reviewed scripts from skill directories, containment-checked, no shell string, timeout), and `codemode` (QuickJS sandbox). If real execution is ever needed beyond that, the right shape is a container or an allowlist — not `spawn` with a shell.

## Presence

The green dot cannot honestly represent this bot: Slack ties presence to client connections, and Socket Mode does not count. The working combination is `always_online: true` plus `users.setPresence` — the bot sets itself away on graceful shutdown and auto on start. A hard crash leaves the dot green until the next cycle; that is a Slack limitation, not a bot bug.

## Tooling choices

The toolchain mirrors the `fantasy-football/frontend` package: TypeScript with oxlint's type-aware rules (`oxlint-tsgolint` — no separate `tsc` step), oxfmt, vitest, pnpm. Runtime is plain Node: Bun was tried as the runtime and compiler (Pi-Bolt's chain) but `@slack/socket-mode` needs `undici.ping()`, which Bun's bundled undici shim does not export — revisit when it does. The type-aware linter cannot resolve Bolt's listener-arg generics, so `src/slack.ts` types them structurally; everything else gets full checking.
