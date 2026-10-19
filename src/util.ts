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
    lines.push(
      `🔧 ${tools.map((tool) => `${tool.name}${tool.status === "running" ? " (running)" : ""}`).join(", ")}`,
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
  return lines.length > 0 ? lines.join("\n\n") : "⏳ thinking…";
}

/** Wrap bare email addresses as Slack mailto anchors; leaves existing links alone. */
export function linkifyEmails(text: string): string {
  return text.replaceAll(/(?<![<>@\w])([\w.+-]+@[\w.-]+\.[a-z]{2,})(?![\w|>])/gi, "<mailto:$1|$1>");
}
