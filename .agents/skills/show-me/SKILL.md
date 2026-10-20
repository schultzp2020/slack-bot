---
name: show-me
description: Explain the current topic visually with concise diagrams, code-shape sketches, diffs, and Slack Block Kit. Use when a structure, flow, or comparison is clearer drawn than said.
disable-model-invocation: true
metadata:
  credits:
    skill: show-me
    author: Dex Horthy
    organisation: HumanLayer
    url: https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md
    adaptation: Slack — Mermaid and HTML artifacts replaced with code fences and Block Kit
---

Help the user understand the current topic of conversation visually. Skip the preamble and keep prose brief. Pick the smallest view that makes the key point clear.

- Show logic or an algorithm as pseudocode:

```text
on(save)
  if content is unchanged
    return cached result
  write new content
  return fresh result
```

- Show runtime control flow as a call tree:

```text
submitForm
  createSession
    persistPrompt
    launchAgent
  navigateToSession
```

- Show file responsibility or a broad refactor as a shallow file tree:

```text
src/
├── commands/       # parses user actions
├── sessions/       # owns session state
└── transport/      # sends API requests
```

- Use `diff` when the point is what changes and the surrounding shape already exists. Match the diff shape to the topic — a component change, a file-layout change, a call-tree change, or a state change.

- For anything richer than a fence can carry — a comparison table, a status board, a card layout, dense structured data — build Slack Block Kit instead of prose. Put the blocks as a JSON array in a fenced block tagged `slack-blocks`; the bot posts it as real blocks and folds your surrounding prose into the message as section blocks (Slack ignores plain text when blocks are present):

````
```slack-blocks
[
  { "type": "header", "text": { "type": "plain_text", "text": "Sprint 42 status" } },
  { "type": "section", "fields": [
    { "type": "mrkdwn_text", "text": "*Committed:* 34 pts" },
    { "type": "mrkdwn_text", "text": "*Done:* 27 pts" }
  ] },
  { "type": "context", "elements": [
    { "type": "mrkdwn_text", "text": "7 issues carry over" }
  ] }
]
```
````

Keep blocks to the few that carry the point: `header`, `section` (with `fields` for side-by-side pairs), `context` for footnotes, `divider` sparingly. Block text fields use mrkdwn (single-asterisk bold, `<URL|label>` links). Never put the whole answer inside one wall of blocks — one focused visual next to short prose beats a dashboard.

### guidance

Place each visual next to the short text it supports. Keep only the calls, files, states, and boundaries needed to answer the user's current question or the options to resolve the current discussion point.

You may use one of these, you may use several, it is unlikely you will use all of them. Use your judgement and don't overwhelm the user.
