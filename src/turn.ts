// One agent turn, shared by mentions, slash commands, schedules, and the
// recovery sweep: reconcile thread context, submit the input (steering when
// busy), stream progress into a placeholder, replace it with the answer.
import type { AllMessageEvents } from "@slack/types";
import { AssistantEntry, LiveDoc, type Harness } from "@earendil-works/pi-durable";
import { markChannelSeen, context } from "./harness.ts";
import { markThreadSeen, openThread, threadLastSeenTs } from "./threads.ts";
import { approvalCode, grantApproval, setTurnRequester } from "./extensions/warden.ts";
import {
  answerText,
  chunkText,
  extractBlocks,
  linkifyEmails,
  liveStatusText,
  mentionUsers,
  settledAnswer,
  splitBlocks,
} from "./util.ts";

/** The Slack client methods a turn uses. */
export interface SlackClient {
  chat: {
    postMessage: (args: {
      channel: string;
      thread_ts?: string;
      text: string;
      blocks?: unknown[];
    }) => Promise<{ ts?: string }>;
    update: (args: {
      channel: string;
      ts: string;
      text: string;
      blocks?: unknown[];
    }) => Promise<unknown>;
    delete: (args: { channel: string; ts: string }) => Promise<unknown>;
  };
  conversations: {
    replies: (args: {
      channel: string;
      ts: string;
      oldest?: string;
      limit: number;
    }) => Promise<{ messages?: unknown[] }>;
    history: (args: {
      channel: string;
      oldest?: string;
      cursor?: string;
      limit: number;
    }) => Promise<{
      messages?: unknown[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    }>;
  };
  users: {
    lookupByEmail: (email: string) => Promise<{ user?: { id?: string } } | undefined>;
  };
}

/** Any message-shaped Slack event we handle. */
interface StructuralMessage {
  subtype?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  user?: string;
}

type SlackMessage = AllMessageEvents | StructuralMessage;

export function isHumanMessage(
  message: SlackMessage,
): message is SlackMessage & { text: string; ts: string; user: string } {
  return (
    message.subtype === undefined &&
    message.bot_id === undefined &&
    message.text !== undefined &&
    message.ts !== undefined &&
    message.user !== undefined
  );
}

/** Remove @-mentions from message text. */
export function stripMentions(text: string): string {
  return text.replaceAll(/<@[^>]+>/g, "").trim();
}

/** Whether a message mentions the bot (and so triggers a turn). */
export function isMentionOfBot(botUserId: string, text: string): boolean {
  return botUserId !== "" && text.includes(`<@${botUserId}>`);
}

/** Blank ping: the user wants the bot to infer the next step from context. */
export const BLANK_PING_TEXT =
  "(The user pinged you with no message. Look at the thread so far and do what you think is the next step; if it is genuinely ambiguous, ask one short question.)";

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
  requestId: string;
  /** Prefix shown in the placeholder (e.g. the slash invocation). */
  placeholderPrefix?: string;
  /** The Slack user who caused this turn; approvals bind to them. */
  requesterUserId?: string;
  /** Source event ts; advances the recovery watermark (never the placeholder's). */
  sourceTs?: string;
}

export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<void> {
  const { harness, client } = deps;

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

  const conversation = await openThread(harness, input.channel, threadTs);
  setTurnRequester(conversation.id, input.requesterUserId);

  // An approval reply ("approve <code>", mentioning the bot) grants the held
  // call; the input then tells the model to retry that exact call.
  const code = approvalCode(input.text);
  let content = input.text;
  if (code !== undefined) {
    const held = grantApproval(conversation.id, code, input.requesterUserId);
    if (held !== undefined) {
      content =
        `[The user approved the held ${held.tool} call (code ${held.code}). ` +
        `Retry exactly that call now — the approval matches only it.]`;
    }
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
  const lastSeen = await threadLastSeenTs(harness, input.channel, threadTs);
  if (lastSeen < progressTs) {
    const replies =
      (
        await client.conversations.replies({
          channel: input.channel,
          ts: threadTs,
          oldest: lastSeen,
          limit: 200,
        })
      ).messages ?? [];
    const unseen = (replies as unknown as AllMessageEvents[]).filter(
      (m): m is AllMessageEvents & { text: string; ts: string; user: string } =>
        isHumanMessage(m) &&
        m.ts > lastSeen &&
        m.ts < progressTs &&
        !isMentionOfBot(deps.botUserId, m.text),
    );
    if (busy) {
      const lines = unseen.map((m) => `<@${m.user}>: ${m.text}`).join("\n");
      if (lines !== "") {
        content = `${content}\n\n[Thread messages sent while you were working — take them into account now:]\n${lines}`;
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
  // Duplicate delivery (Slack retry, a recovery re-sweep): the requestId
  // deduped us onto an already-settled submission — the answer was posted by
  // the original turn. Delete the placeholder and post nothing.
  const early = await submission.status(context);
  if ("status" in early && early.status === "done") {
    void live?.stop();
    await client.chat.delete({ channel: input.channel, ts: progressTs }).catch(() => undefined);
    return;
  }
  const settled = await submission.wait(context);
  void live?.stop();
  const answerEntryId = settledAnswer(settled);
  const reply = answerEntryId
    ? answerText(
        await conversation.commit((tx) => tx.entry(AssistantEntry, answerEntryId), context),
      )
    : `unanswered: ${"reason" in settled ? settled.reason : "unknown"}`;
  // A ```slack-blocks fence in the reply becomes real Block Kit blocks.
  // Slack renders blocks and IGNORES the text field when blocks are present,
  // so the prose around the fence must ride along as section blocks or it is
  // lost — including approval instructions. Long replies split into multiple
  // messages at Slack's limits (text-object ~3000 chars, 50 blocks/message):
  // the first batch replaces the placeholder, the rest follow in the thread.
  // Emails that resolve to workspace members become @mentions.
  const { blocks, before, after } = extractBlocks(reply);
  const mentioned = await mentionUsers(
    deps.client.users,
    linkifyEmails(`${before}${before !== "" && after !== "" ? "\n\n" : ""}${after}`),
  );
  if (blocks.length > 0) {
    const prose = (text: string) =>
      text === "" ? [] : [{ type: "section", text: { type: "mrkdwn", text } }];
    const batches = splitBlocks([...prose(before), ...blocks, ...prose(after)]);
    await client.chat
      .update({
        channel: input.channel,
        ts: progressTs,
        text: mentioned.slice(0, 3900),
        blocks: batches[0],
      })
      .catch(() =>
        client.chat.update({
          channel: input.channel,
          ts: progressTs,
          text: mentioned.slice(0, 3900),
        }),
      );
    for (const batch of batches.slice(1)) {
      await client.chat
        .postMessage({ channel: input.channel, thread_ts: threadTs, text: "", blocks: batch })
        .catch(() => undefined);
    }
  } else {
    const chunks = chunkText(mentioned);
    await client.chat.update({ channel: input.channel, ts: progressTs, text: chunks[0] });
    for (const chunk of chunks.slice(1)) {
      await client.chat
        .postMessage({ channel: input.channel, thread_ts: threadTs, text: chunk })
        .catch(() => undefined);
    }
  }

  // Advance the channel watermark to the SOURCE event ts (never the
  // placeholder's, which is newer than unprocessed offline events), so the
  // recovery sweep resumes exactly behind what has actually been handled.
  if (input.sourceTs !== undefined) {
    await markChannelSeen(harness, input.channel, input.sourceTs);
  }
}

export interface MentionInput {
  channel: string;
  /** The mention message's own ts. */
  ts: string;
  /** The thread the mention lives in; a root mention threads under itself. */
  thread_ts?: string;
  /** Raw message text, mentions included. */
  text: string;
  /** The Slack user who sent it. */
  user: string;
}

/**
 * Normalize a mention into a turn input: strip mentions, blank-ping fallback,
 * thread placement (root mentions thread under themselves, so retries and
 * recoveries land in the same conversation), request identity, requester
 * binding, and the recovery watermark source. One place, for live and
 * recovered mentions alike.
 */
export function normalizeMention(mention: MentionInput): TurnInput {
  const text = stripMentions(mention.text);
  return {
    channel: mention.channel,
    threadTs: mention.thread_ts ?? mention.ts,
    text: text !== "" ? text : BLANK_PING_TEXT,
    requestId: `slack:${mention.ts}`,
    requesterUserId: mention.user,
    sourceTs: mention.ts,
  };
}

/** Run one Slack mention, live or recovered. */
export async function runMention(deps: TurnDeps, mention: MentionInput): Promise<void> {
  await runTurn(deps, normalizeMention(mention));
}
