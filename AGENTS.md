# slack-bot

A Slack-fronted agent on the pi-durable harness: Jira, GitHub, and GitLab worked through Slack threads. Slack is transport only; behavior lives in `src/extensions/`.

- `docs/tutorial.md` — from clone to first triage answer.
- `docs/how-to.md` — recipes: add a tool, add a skill, restart safely, calibrate the warden.
- `docs/reference.md` — configuration, tools, Slack scopes, npm scripts.
- `docs/explanation.md` — how the pieces fit and why they are that shape.

## Ground rules

- **One process owns `data/session.sqlite`.** The PID lockfile in `src/index.ts` enforces it; never bypass it. A second live instance corrupts pi-durable's in-process ID minting.
- **A new tool is a new file in `src/extensions/`**, default-exporting an Extension — discovered and enabled automatically. In the same file, push an entry onto `offlineFloors` (registry in `src/extensions/warden.ts`): a tool without a floor holds on every classifier outage, which is the intended fail-closed default.
- **Type Slack listener args structurally** (see `src/slack.ts`). Bolt's generic inference does not resolve under oxlint's type checker.
- **Author regexes with the edit tool, never bash heredocs** — the shell corrupts `\b` into backspace bytes. The test suite is the tripwire; keep pure helpers exported and covered.
- **pi-durable gotchas**: `tx.createConversation` takes `ownership` only — agent choices go through `conversation.configure()`, which is idempotent. Tool parameter schemas are TypeBox, not Zod. Submissions dedupe by `requestId`, scoped per conversation.
