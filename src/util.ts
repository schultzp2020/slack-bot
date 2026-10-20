import type { EntryId, EntryRecord, LiveState } from "@earendil-works/pi-durable";

/** Stable key for the session-scoped thread map: one durable conversation per Slack thread. */
export function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

/** Extract the assistant's text from a settled answer entry. */
export function answerText(entry: EntryRecord | undefined): string {
  const messages = entry?.model ?? [];
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** EntryId of a successfully answered input submission, else undefined. */
export function settledAnswer(
  settled: { status: string; type: string } & Partial<{ answer: EntryId; reason: string }>,
): EntryId | undefined {
  return settled.status === "done" && settled.type === "input" ? settled.answer : undefined;
}

/** One status line for the streaming placeholder: tool round, partial answer, or thinking dot. */
export function liveStatusText(value: Readonly<LiveState> | null | undefined): string {
  const lines: string[] = [];
  const tools = value?.tools ?? [];
  if (tools.length > 0) {
    // Tool rounds as a mrkdwn list: bold names, emoji state, newest last.
    lines.push(
      tools
        .map((tool) => {
          const marker = tool.status === "running" ? "⚙️" : tool.status === "done" ? "✅" : "•";
          const name = tool.status === "running" ? `*${tool.name}*` : tool.name;
          return `${marker} ${name}`;
        })
        .join("\n"),
    );
  }
  const partial = value?.generation?.message as
    | { content?: { type: string; text?: string }[] }
    | undefined;
  const text = (partial?.content ?? [])
    .filter((block) => block.type === "text" && block.text !== undefined)
    .map((block) => block.text)
    .join("");
  if (text !== "") {
    lines.push(text);
  }
  return lines.length > 0 ? lines.join("\n\n") : "🧠 thinking…";
}

/** Wrap bare email addresses as Slack mailto anchors; leaves existing links alone. */
export function linkifyEmails(text: string): string {
  return text.replaceAll(/(?<![<>@\w])([\w.+-]+@[\w.-]+\.[a-z]{2,})(?![\w|>])/gi, "<mailto:$1|$1>");
}

/**
 * The positional command path of an argv: every --flag and its value are
 * query parameters, not actions, so they are skipped. Lowercased for
 * verb matching.
 */
export function commandPath(argv: readonly string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      i++;
      continue;
    }
    positional.push(argv[i].toLowerCase());
  }
  return positional;
}

/**
 * Split a reply into Slack Block Kit blocks and fallback text: a
 * ```slack-blocks fence holding a JSON array of blocks is posted as real
 * blocks; the rest of the reply is the text fallback. Returns no blocks when
 * the fence is absent or the JSON does not parse as an array.
 */
export function extractBlocks(reply: string): { blocks: unknown[]; text: string } {
  const fence = /```slack-blocks\n([\s\S]*?)```/.exec(reply);
  if (fence === null) {
    return { blocks: [], text: reply };
  }
  const stripped = (
    reply.slice(0, fence.index) + reply.slice(fence.index + fence[0].length)
  ).trim();
  try {
    const parsed: unknown = JSON.parse(fence[1]);
    if (Array.isArray(parsed)) {
      return { blocks: parsed, text: stripped };
    }
  } catch {
    // fall through: not valid JSON, post as plain text
  }
  return { blocks: [], text: reply };
}

export interface UserLookup {
  lookupByEmail: (email: string) => Promise<{ user?: { id?: string } } | undefined>;
}

/**
 * Replace email references (mailto links and bare addresses) with Slack user
 * mentions when the address resolves to a workspace member; unresolved
 * addresses keep their mailto link. Lookups are cached per call.
 */
export async function mentionUsers(lookup: UserLookup, text: string): Promise<string> {
  const emails = new Set<string>();
  for (const m of text.matchAll(/<mailto:([^|>]+)[^>]*>/g)) {
    emails.add(m[1].toLowerCase());
  }
  for (const m of text.matchAll(/(?<![<>@\w])([\w.+-]+@[\w.-]+\.[a-z]{2,})(?![\w|>])/gi)) {
    emails.add(m[1].toLowerCase());
  }
  const mentions = new Map<string, string>();
  for (const email of emails) {
    try {
      const found = await lookup.lookupByEmail(email);
      const id = found?.user?.id;
      if (id !== undefined && id !== "") {
        mentions.set(email, `<@${id}>`);
      }
    } catch {
      // not a workspace member or lookup failed: keep the mailto link
    }
  }
  if (mentions.size === 0) {
    return text;
  }
  return text
    .replaceAll(
      /<mailto:([^|>]+)(\|[^>]*)?>/g,
      (full, email: string) => mentions.get(email.toLowerCase()) ?? full,
    )
    .replaceAll(
      /(?<![<>@\w])([\w.+-]+@[\w.-]+\.[a-z]{2,})(?![\w|>])/gi,
      (full, email: string) => mentions.get(email.toLowerCase()) ?? full,
    );
}
