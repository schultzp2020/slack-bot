# slack-bot

A Slack-fronted agent built on [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi) — the durable conversation, task, and tool runtime behind Pi.

Mention the bot in a Slack thread and it answers using tools you control: Jira today, GitHub and GitLab next. Every thread maps to one durable conversation that survives restarts; teammates can discuss in the thread for hours and the bot reads the whole discussion on the next ping.

## What's in the box

- **Durable by construction** — conversations, tool calls, and model turns commit to SQLite before anything is shown. A crash resumes mid-run from the last commit.
- **Discovered extensions** — a tool is a file in `src/extensions/`, auto-installed and enabled. Ships with `jira` (Atlassian CLI), `skills` ([agentskills.io](https://agentskills.io) discovery + scoped script runner), `codemode` (QuickJS sandbox for model-written JavaScript), and `warden`.
- **The warden** — a local-classifier approval gate (after [pi-warden](https://github.com/DevMortimer/pi-warden), judged by your own [llama.cpp](https://github.com/ggml-org/llama.cpp) System One model instead of a hosted one). Write-shaped tool calls are held until a human approves in the thread; read-only calls pass without a classifier round-trip; tool output is scored for prompt injection before the model sees it.
- **No shell, by design** — the model runs reviewed scripts from skill directories and nothing else.

## Quick start

```bash
pnpm install
cp .env.example .env   # fill in Slack tokens + model gateway key
pnpm dev
```

Full setup (Slack app manifest, model gateway, classifier): see the [tutorial](docs/tutorial.md).

## Documentation

- [Tutorial](docs/tutorial.md) — from clone to first answer
- [How-to guides](docs/how-to.md) — add a tool, add a skill, calibrate the warden
- [Reference](docs/reference.md) — configuration, tools, storage
- [Explanation](docs/explanation.md) — architecture and design decisions

## Requirements

Node 24+ (TypeScript runs natively), pnpm, the Atlassian CLI for the Jira tool, and optionally a local llama.cpp server for the warden.
