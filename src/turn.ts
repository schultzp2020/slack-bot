// One agent turn, shared by mentions, slash commands, schedules, and the
// recovery sweep: reconcile thread context, submit the input (steering when
// busy), stream progress into a placeholder, replace it with the answer.
import type { AllMessageEvents, GenericMessageEvent } from "@slack/types";
import { AssistantEntry, LiveDoc, type Harness } from "@earendil-works/pi-durable";
import { WARDEN_APPROVAL_WINDOW_MS } from "./config.ts";
import { WardenDoc, approvalRegex } from "./extensions/warden.ts";
import {
  markChannelSeen,
  markThreadSeen,
  threadConversation,
  threadLastSeenTs,
  context,
} from "./harness.ts";
import { answerText, linkifyEmails, liveStatusText, settledAnswer } from "./util.ts";

/** The Slack client methods a turn uses. */
export interface SlackClient {
  chat: {
    postMessage: (args: {
      channel: string;
      thread_ts?: string;
      text: string;
    }) => Promise<{ ts?: string }>;
    update: (args: { channel: string; ts: string; text: string }) => Promise<unknown>;
  };
  conversations: {
    replies: (args: {
      channel: string;
      ts: string;
      limit: number;
    }) => Promise<{ messages?: unknown[] }>;
    history: (args: {
      channel: string;
      oldest?: string;
      limit: number;
    }) => Promise<{ messages?: unknown[] }>;
  };
}

/** Any message-shaped Slack event we handle. */
type SlackMessage =
  | AllMessageEvents
  | { subtype?: string; bot_id?: string; text?: string; ts?: string; user?: string };

export function isHumanMessage(
  message: SlackMessage,
): message is GenericMessageEvent & { text: string } {
  return (
    message.subtype === undefined &&
    message.bot_id === undefined &&
    message.text !== undefined &&
    message.user !== undefined
  );
}

export interface TurnDeps {
  harness: Harness;
  client: SlackClient;
  botUserId: string;
}

export interface TurnInput {
  channel: string;
  /** Thread to run in; omit to start a new thread from the placeholder. */
  threadTs?: string;
  /** Final input content for the model. */
  text: string;
  /** The user's raw text, for approval detection. */
  rawText: string;
  requestId: string;
  /** Prefix shown in the placeholder (e.g. the slash invocation). */
  placeholderPrefix?: string;
}

export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<void> {
  const { harness, client } = deps;
  const isMentionOfBot = (text: string) =>
    deps.botUserId !== "" && text.includes(`<@${deps.botUserId}>`);

  // Placeholder first: for a new thread it is the root message.
  const placeholder = await client.chat.postMessage({
    channel: input.channel,
    ...(input.threadTs !== undefined ? { thread_ts: input.threadTs } : {}),
    text: `${input.placeholderPrefix ?? ""}⏳ thinking…`.trim(),
  });
  const progressTs = placeholder.ts;
  if (progressTs === undefined) {
    throw new Error("Slack returned no ts for the progress placeholder");
  }
  const threadTs = input.threadTs ?? progressTs;

  const conversation = await threadConversation(harness, input.channel, threadTs);

  // An approval reply opens the warden gate for this conversation's next risky call.
  if (approvalRegex().test(input.rawText)) {
    await harness.commit(async (tx) => {
      const warden = await tx.doc(WardenDoc, conversation.id);
      warden.approvalUntil = Date.now() + WARDEN_APPROVAL_WINDOW_MS;
    }, context);
  }

  // Pull unseen human replies, so the turn sees the whole thread. When the
  // conversation is busy they ride along in the steer input (the model sees
  // them mid-run); when idle they land as context-only writes first.
  const busyReader = harness as unknown as {
    snapshot: (
      token: typeof LiveDoc,
      conversationId: number,
      ctx: typeof context,
    ) => Promise<{ run?: unknown } | undefined>;
  };
  const busy = (await busyReader.snapshot(LiveDoc, conversation.id, context))?.run !== undefined;
  let content = input.text;
  const lastSeen = await threadLastSeenTs(harness, input.channel, threadTs);
  if (lastSeen < progressTs) {
    const replies =
      (await client.conversations.replies({ channel: input.channel, ts: threadTs, limit: 200 }))
        .messages ?? [];
    const unseen = (replies as unknown as AllMessageEvents[]).filter(
      (m): m is AllMessageEvents & { text: string; ts: string; user: string } =>
        isHumanMessage(m) && m.ts > lastSeen && m.ts < progressTs && !isMentionOfBot(m.text),
    );
    if (busy) {
      const lines = unseen.map((m) => `<@${m.user}>: ${m.text}`).join("\n");
      if (lines !== "") {
        content = `${input.text}\n\n[Thread messages sent while you were working — take them into account now:]\n${lines}`;
      }
    } else {
      for (const message of unseen) {
        await conversation.submit(
          {
            type: "write",
            entry: {
              kind: "slack.message",
              model: [
                {
                  role: "user",
                  content: [{ type: "text", text: `<@${message.user}>: ${message.text}` }],
                  timestamp: Date.now(),
                },
              ],
            },
            requestId: `slack:${message.ts}`,
          },
          context,
        );
      }
    }
    await markThreadSeen(harness, input.channel, threadTs, progressTs);
  }

  let lastUpdate = 0;
  const live = await harness.watchDoc(LiveDoc, conversation.id, context);
  live?.start(async (value) => {
    const now = Date.now();
    if (now - lastUpdate < 1200) {
      return; // 1.2s throttle keeps us far under Slack rate limits
    }
    lastUpdate = now;
    await client.chat
      .update({
        channel: input.channel,
        ts: progressTs,
        text: liveStatusText(value).slice(0, 3900),
      })
      .catch(() => undefined); // deleted/failed placeholder — stop updating silently
  });

  const submission = await conversation.submit(
    { type: "input", content, whenBusy: "steer", requestId: input.requestId },
    context,
  );
  const settled = await submission.wait(context);
  void live?.stop();
  const answerEntryId = settledAnswer(settled);
  const reply = answerEntryId
    ? answerText(
        await conversation.commit((tx) => tx.entry(AssistantEntry, answerEntryId), context),
      )
    : `unanswered: ${"reason" in settled ? settled.reason : "unknown"}`;
  await client.chat.update({
    channel: input.channel,
    ts: progressTs,
    text: linkifyEmails(reply).slice(0, 3900),
  });

  // Advance the channel watermark so the recovery sweep never rescans this.
  await markChannelSeen(harness, input.channel, progressTs);
}
