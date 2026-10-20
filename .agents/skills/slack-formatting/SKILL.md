---
name: slack-formatting
description: Complete Slack mrkdwn and Block Kit reference for app-published messages — styles, lists, links, mentions, dates, escaping, automatic parsing, and rich layouts. Always loaded; follow it exactly when writing replies.
metadata:
  credits:
    url: https://docs.slack.dev/messaging/formatting-message-text/
    author: Slack
    adaptation: distilled for this bot; the Slack docs are the source of truth
---

# Slack message formatting reference

Slack's `mrkdwn` is inspired by markdown but uses different rules. Where it applies:

- Most Block Kit text objects, by setting `"type": "mrkdwn"` (some blocks take only `plain_text`).
- The top-level `text` field of a published message (default formatting method).
- `markdown_text` for streaming conversations.

## Basic visual styles

- `_italic_` — italicized text
- `*bold*` — bold text (single asterisks; `**` renders literally)
- `~strike~` — strikethrough

**Styles do not nest.** Slack mrkdwn picks one format per span: `*bold with `code` inside*` shows the markers literally, and `*<url|label>*` breaks the link — links are already visually styled, so never wrap them in bold or italics; bold the surrounding words instead. Inline code cannot sit inside bold.

## Line breaks

Multi-line text works in app-published messages: include `\n` for a newline.

## Block quotes

`>` at the beginning of one or more lines quotes them:

```
This is unquoted text\n>This is quoted text\n>This is still quoted text
```

## Code

- Inline: surround with backticks — `` `inline *code*` ``. No other formatting applies inside, so backticks also neutralize stray mrkdwn from tool output.
- Multi-line: three backticks before and after the block.

## Lists

There is no list syntax in app-published text. Mimic bullets with plain prefixes and line breaks — `• item` or `- item` lines. `* item` at line start is a bold marker, not a bullet; do not use it for lists. Real formatted lists (nesting, indentation) require Block Kit rich text or section `fields`.

## Links

- Bare URLs auto-transform into links; keep them free of spaces.
- Manual: `<https://example.com/>`
- Custom label: `<https://docs.slack.dev/|This message is a link>`
- Email: `<mailto:person@example.com|Email Person>`

Retrieved messages come back with links already in `<url|label>` form — parse that shape when reading history.

## Emoji

Include unicode emoji directly; Slack converts them to colon format (`🎉` → `:tada:`) internally. Retrieved messages carry colon format. Block Kit buttons and `plain_text` fields accept `:name:` colon format.

## Escaping

`&`, `<`, `>` are control characters for special parsing. Literal occurrences must be HTML entities: `&amp;`, `&lt;`, `&gt;`. Escape only these characters, only where they are not doing parsing duty — and always inside text echoed from tool output, so untrusted content cannot forge mentions or links.

# Advanced formatting

## Linking channels

`<#C123ABC456>` renders as the channel's name. Get IDs from event payloads or the conversations API. Members without access to a linked private channel see an unclickable `private channel` label.

## Mentioning users

`<@U012AB3CD>` renders the display name and links the profile. App-published mentions notify the user only if they are already a member of the channel.

## Mentioning user groups

`<!subteam^SAZ94GDB8>` — the `!subteam^` prefix is literal, followed by the group ID. Notifies every user in the group.

## Special mentions

Use sparingly — they notify broadly:

- `<!here>` — active channel members
- `<!channel>` — all channel members
- `<!everyone>` — every member of `#general`

## Date formatting

`<!date^timestamp^token_string^optional_link|fallback_text>` renders in each reader's local timezone. `timestamp` is Unix seconds; `^` separates parts. Tokens:

- `{date_num}` — `2014-02-18`
- `{date}` — `February 18th, 2014` (year omitted within six months)
- `{date_short}` — `Feb 18, 2014`
- `{date_long}` — `Tuesday, February 18th, 2014`
- `{date_pretty}`, `{date_short_pretty}`, `{date_long_pretty}` — same, with yesterday/today/tomorrow
- `{time}` — `6:39 AM` (or 24-hour per the reader's client)
- `{time_secs}` — `6:39:45 AM`
- `{ago}` — `3 minutes ago`

Examples:

```
<!date^1392734382^Posted {date_num} {time_secs}|Posted 2014-02-18 6:39:42 AM PST>
<!date^1392734382^{date} at {time}|February 18th, 2014 at 6:39 AM PST>
```

Always include fallback text with explicit timezone.

## Automatic parsing

User-style text (`#general`, `@here`, bare URLs, `:emoji:`) can be auto-parsed on publish. Prefer the manual ID-based syntax above: names change, IDs do not; automatic user-mention parsing is already deprecated; and unparsed third-party text like `@everyone` could otherwise notify a whole workspace.

# Rich message layouts (Block Kit)

For structure beyond inline formatting — headers, side-by-side fields, dense data — compose Block Kit layout blocks. Each block is a JSON object with a `type`; blocks stack in an array in visual order:

```
[
  { "type": "header", "text": { "type": "plain_text", "text": "New request" } },
  { "type": "section", "fields": [
    { "type": "mrkdwn", "text": "*Type:*\nPaid Time Off" },
    { "type": "mrkdwn", "text": "*Created by:*\n<https://example.com|Fred>" }
  ] },
  { "type": "section", "text": { "type": "mrkdwn", "text": "<https://example.com|View request>" } }
]
```

Notes for this bot:

- Emit a blocks array as a fenced block tagged `slack-blocks`. Prose outside the fence is preserved — the bot folds it into the message as section blocks before and after yours (Slack ignores the text field when blocks are present, so everything visible must be a block).
- Keep ALL user-visible content in the reply: when you use a fence, the approval instructions and any closing notes must be either inside your blocks or in the surrounding prose, never assumed.
- `header` takes `plain_text`, never `mrkdwn`.
- `section.fields` renders mrkdwn pairs two-across; use for label/value pairs.
- `context` holds footnote-level mrkdwn; `divider` separates sparingly.
- Rich text blocks support true lists (bulleted, ordered, nested) when list structure matters more than a simple card.
