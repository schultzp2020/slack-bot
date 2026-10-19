# Tutorial: run the bot

This tutorial takes you from a fresh clone to a Jira triage answer in a Slack thread. Expect about 20 minutes, most of it in Slack app configuration.

## What you will build

A bot that, when mentioned in a Slack thread, answers questions about issues in your Jira tracker using the Atlassian CLI, with every conversation durably stored so threads survive restarts.

## Prerequisites

- Node.js 24+ (TypeScript runs natively, no build step)
- pnpm
- The Atlassian CLI (`acli`) installed and authenticated
- A Slack workspace where you can create apps

## 1. Install dependencies

```bash
pnpm install
```

## 2. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and choose **Create New App → From manifest**.
2. Paste the contents of `manifest.yml` and save.
3. Install the app to your workspace.
4. Copy the **Bot User OAuth Token** (`xoxb-…`) from _OAuth & Permissions_.
5. Under _Basic Information → App-Level Tokens_, generate a token with the `connections:write` scope (`xapp-…`).

## 3. Configure the environment

Copy `.env.example` to `.env` and fill in:

- `SLACK_BOT_TOKEN` — the `xoxb-` token
- `SLACK_APP_TOKEN` — the `xapp-` token
- `MODEL_API_KEY` — a key for the OpenAI-compatible model gateway (and optionally `MODEL_BASE_URL` if not using the committed default)

Optional keys (`MODEL_ID`, warden settings) have sensible defaults; see `docs/reference.md`.

## 4. Start the bot

```bash
pnpm dev
```

You should see `slack-bot up (socket mode, pi-durable harness)`. If you see a message about another instance holding `data/bot.lock`, an earlier process is still alive — stop it first.

## 5. Talk to it

1. Invite the bot to a channel: `/invite @triage`
2. Ask about an issue: `@triage what is the status of PROJ-123?`
3. While it works, the placeholder message streams progress (🔧 tool name, then partial answer text) and is replaced by the final answer.

Try the multi-user flow: have teammates discuss in the thread without mentioning the bot, then ping it — it reads the whole discussion since its last reply and acts on it.

## Where to go next

- `docs/how-to.md` for extending the bot
- `docs/explanation.md` for how it works
