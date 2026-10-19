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
import { channelWatermarks, markChannelSeen } from "./harness.ts";
import { recoveryThreadCursors } from "./threads.ts";
import {
  isHumanMessage,
  isMentionOfBot,
  runMention,
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
        await runMention(deps, {
          channel,
          ts: message.ts,
          ...("thread_ts" in message && message.thread_ts !== undefined
            ? { thread_ts: message.thread_ts }
            : {}),
          text: message.text,
          user: message.user,
        });
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
  // thread from its recovery cursor. (Mentions in threads the bot never
  // joined are the remaining gap — those need a durable mention inbox, not a
  // pull sweep.)
  const cursors = await recoveryThreadCursors(harness);
  for (const { channel, threadTs, since } of cursors) {
    try {
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
        await runMention(deps, {
          channel,
          ts: message.ts,
          thread_ts: threadTs,
          text: message.text,
          user: message.user,
        });
      }
    } catch (error) {
      console.error(`recovery sweep of thread ${channel}:${threadTs} failed:`, error);
    }
  }
}
