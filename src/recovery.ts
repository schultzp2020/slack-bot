// Startup recovery: mentions that arrived while the bot was down are answered
// after restart. Per-channel watermarks (app.channels) record the newest
// source message the bot has processed — never a placeholder ts, which would
// be newer than unprocessed offline events. The sweep runs BEFORE the Slack
// connection opens (live traffic then cannot jump the watermark past missed
// events), walks channel history oldest-first with full pagination, and also
// sweeps the replies of every mapped thread. A crash mid-sweep resumes from
// the last committed watermark; the frontier only advances over messages
// actually scanned.
import type { AllMessageEvents } from "@slack/types";
import {
  channelWatermarks,
  markChannelSeen,
  threadIndexSnapshot,
  threadLastSeenTs,
} from "./harness.ts";
import {
  BLANK_PING_TEXT,
  isHumanMessage,
  isMentionOfBot,
  runTurn,
  stripMentions,
  type SlackClient,
  type TurnDeps,
} from "./turn.ts";

/** Pull a channel's human messages after `since`, oldest-first, fully paginated. */
export async function historySince(
  client: SlackClient,
  channel: string,
  since: string,
): Promise<(AllMessageEvents & { text: string; ts: string; user: string })[]> {
  const messages: (AllMessageEvents & { text: string; ts: string; user: string })[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.conversations.history({
      channel,
      oldest: since,
      ...(cursor !== undefined ? { cursor } : {}),
      limit: 200,
    });
    for (const message of (page.messages ?? []) as unknown as AllMessageEvents[]) {
      if (isHumanMessage(message)) {
        messages.push(message);
      }
    }
    cursor = page.has_more ? page.response_metadata?.next_cursor : undefined;
  } while (cursor !== undefined && cursor !== "");
  return messages.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Every mention in `messages`, oldest-first. */
export function mentionsOfBot(
  botUserId: string,
  messages: readonly (AllMessageEvents & { text: string; ts: string; user: string })[],
): (AllMessageEvents & { text: string; ts: string; user: string })[] {
  return messages.filter((message) => isMentionOfBot(botUserId, message.text));
}

/** Run one recovered mention. */
async function recoverMention(
  deps: TurnDeps,
  channel: string,
  threadTs: string | undefined,
  message: { text: string; ts: string; user: string },
): Promise<void> {
  const text = stripMentions(message.text);
  await runTurn(deps, {
    channel,
    ...(threadTs !== undefined ? { threadTs } : {}),
    text: text !== "" ? text : BLANK_PING_TEXT,
    requestId: `slack:${message.ts}`,
    requesterUserId: message.user,
    sourceTs: message.ts,
  });
}

export async function recoverMissedMentions(deps: TurnDeps): Promise<void> {
  const { harness, client, botUserId } = deps;
  const watermarks = await channelWatermarks(harness);

  for (const [channel, since] of Object.entries(watermarks)) {
    try {
      const messages = await historySince(client, channel, since);
      for (const message of messages) {
        if (!isMentionOfBot(botUserId, message.text)) {
          continue;
        }
        await recoverMention(deps, channel, (message as { thread_ts?: string }).thread_ts, message);
      }
      // Advance only over scanned source messages, so a crash mid-sweep (or a
      // crash between two mentions) never skips unprocessed ones.
      const frontier = messages.at(-1)?.ts;
      if (frontier !== undefined && frontier > since) {
        await markChannelSeen(harness, channel, frontier);
      }
    } catch (error) {
      console.error(`recovery sweep of ${channel} failed:`, error);
    }
  }

  // Thread replies are not part of channel history: sweep every mapped
  // thread for mentions newer than its last-seen ts. (Mentions in threads the
  // bot never joined are the remaining gap — those need a durable mention
  // inbox, not a pull sweep.)
  const threads = await threadIndexSnapshot(harness);
  for (const [key, lastUsed] of Object.entries(threads)) {
    const [channel, threadTs] = key.split(":");
    if (channel === "" || threadTs === "" || !key.includes(":")) {
      continue; // malformed key; threadKey always produces channel:ts
    }
    try {
      const lastSeen = await threadLastSeenTs(harness, channel, threadTs);
      const since = lastSeen > "0" ? lastSeen : lastUsed;
      const replies = await client.conversations.replies({
        channel,
        ts: threadTs,
        oldest: since,
        limit: 200,
      });
      for (const message of (replies.messages ?? []) as unknown as AllMessageEvents[]) {
        if (!isHumanMessage(message) || !isMentionOfBot(botUserId, message.text)) {
          continue;
        }
        await recoverMention(deps, channel, threadTs, message);
      }
    } catch (error) {
      console.error(`recovery sweep of thread ${key} failed:`, error);
    }
  }
}
