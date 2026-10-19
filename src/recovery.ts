// Startup recovery: mentions that arrived while the bot was down are answered
// after restart. Per-channel watermarks (app.channels) record the newest
// message the bot has processed; the sweep pulls each known channel's history
// since that point and runs every missed mention, oldest first.
import type { AllMessageEvents } from "@slack/types";
import { channelWatermarks, markChannelSeen } from "./harness.ts";
import { isHumanMessage, runTurn, type TurnDeps } from "./turn.ts";

const BLANK_PING =
  "(The user pinged you with no message. Look at the thread so far and do what you think is the next step; if it is genuinely ambiguous, ask one short question.)";

export async function recoverMissedMentions(deps: TurnDeps): Promise<void> {
  const { harness, client, botUserId } = deps;
  const isMentionOfBot = (text: string) => botUserId !== "" && text.includes(`<@${botUserId}>`);
  const watermarks = await channelWatermarks(harness);

  for (const [channel, since] of Object.entries(watermarks)) {
    try {
      const history = await client.conversations.history({ channel, oldest: since, limit: 200 });
      const messages = ((history.messages ?? []) as unknown as AllMessageEvents[])
        .filter(isHumanMessage)
        .sort((a, b) => a.ts.localeCompare(b.ts));
      let newest = since;
      for (const message of messages) {
        if (message.ts > newest) {
          newest = message.ts;
        }
        if (!isMentionOfBot(message.text)) {
          continue;
        }
        const text = message.text.replaceAll(/<@[^>]+>/g, "").trim();
        await runTurn(deps, {
          channel,
          ...(message.thread_ts !== undefined ? { threadTs: message.thread_ts } : {}),
          text: text !== "" ? text : BLANK_PING,
          rawText: text,
          requestId: `slack:${message.ts}`,
        });
      }
      if (newest > since) {
        await markChannelSeen(harness, channel, newest);
      }
    } catch (error) {
      console.error(`recovery sweep of ${channel} failed:`, error);
    }
  }
}
