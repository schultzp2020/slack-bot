// Slack transport: Bolt Socket Mode relay. Transport only — a ping submits an
// input to the durable conversation for that thread, after pulling any unseen
// human replies into it as context-only writes. The settled answer replaces a
// streaming progress placeholder.
import type { AllMessageEvents, GenericMessageEvent } from "@slack/types";
import { App } from "@slack/bolt";
import { AssistantEntry, LiveDoc, type Harness } from "@earendil-works/pi-durable";
import { threadConversation, threadLastSeenTs, markThreadSeen, context } from "./harness.ts";
import { WARDEN_APPROVAL_WINDOW_MS } from "./config.ts";
import { WardenDoc, approvalRegex } from "./extensions/warden.ts";
import { answerText, linkifyEmails, liveStatusText, settledAnswer } from "./util.ts";

/** Any message-shaped Slack event we handle. */
type SlackMessage = AllMessageEvents | MentionEvent;

function isHumanMessage(message: SlackMessage): message is GenericMessageEvent & { text: string } {
  return (
    message.subtype === undefined &&
    message.bot_id === undefined &&
    message.text !== undefined &&
    message.user !== undefined
  );
}

/** The mention fields this relay uses; structural so no SDK generics are involved. */
interface MentionEvent {
  subtype?: string;
  bot_id?: string;
  user?: string;
  text: string;
  ts: string;
  channel: string;
  thread_ts?: string;
}

/** The client methods this relay uses. */
interface SlackClient {
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
  };
}

export async function startSlackApp(
  harness: Harness,
): Promise<{ slack: App; setStatus: (online: boolean) => Promise<unknown> }> {
  const slack = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  const auth = await slack.client.auth.test();
  const botUserId = auth.user_id ?? "";
  const isMentionOfBot = (text: string) => botUserId !== "" && text.includes(`<@${botUserId}>`);

  /** Pull unseen human replies, so a ping sees the whole thread. Marks them seen. */
  async function pullUnseen(
    channel: string,
    threadTs: string,
    upTo: string,
  ): Promise<(GenericMessageEvent & { text: string })[]> {
    const lastSeen = await threadLastSeenTs(harness, channel, threadTs);
    if (lastSeen >= upTo) {
      return [];
    }
    const replies =
      (await slack.client.conversations.replies({ channel, ts: threadTs, limit: 200 })).messages ??
      [];
    const unseen = (replies as unknown as AllMessageEvents[]).filter(
      (m): m is GenericMessageEvent & { text: string } =>
        isHumanMessage(m) && m.ts > lastSeen && m.ts < upTo && !isMentionOfBot(m.text),
    );
    await markThreadSeen(harness, channel, threadTs, upTo);
    return unseen;
  }

  // chisle: Bolt's listener-arg generics don't resolve under tsgolint; shallow structural types instead.
  slack.event("app_mention", async (args) => {
    const { event, client, logger } = args as unknown as {
      event: MentionEvent;
      client: SlackClient;
      logger: { error: (error: unknown) => void };
    };
    try {
      if (!isHumanMessage(event)) {
        return;
      }
      const text = event.text.replaceAll(/<@[^>]+>/g, "").trim();
      // Blank ping: the user wants the bot to infer the next step from context.
      const content =
        text !== ""
          ? text
          : "(The user pinged you with no message. Look at the thread so far and do what you think is the next step; if it is genuinely ambiguous, ask one short question.)";
      const threadTs = event.thread_ts ?? event.ts;
      const conversation = await threadConversation(harness, event.channel, threadTs);
      const unseen = await pullUnseen(event.channel, threadTs, event.ts);

      // An approval reply opens the warden gate for this conversation's next risky call.
      if (approvalRegex().test(text)) {
        await harness.commit(async (tx) => {
          const warden = await tx.doc(WardenDoc, conversation.id);
          warden.approvalUntil = Date.now() + WARDEN_APPROVAL_WINDOW_MS;
        }, context);
      }

      // A ping while the bot is thinking steers the running work; the unseen
      // thread replies ride along in the steer so the model sees them now.
      // When idle they land as context-only writes before the input instead.
      const busy = (await harness.snapshot(LiveDoc, conversation.id, context))?.run !== undefined;
      let input = content;
      if (busy) {
        const lines = unseen.map((m) => `<@${m.user}>: ${m.text}`).join("\n");
        if (lines !== "") {
          input = `${content}\n\n[Thread messages sent while you were working — take them into account now:]\n${lines}`;
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

      // Placeholder that streams progress, replaced by the final answer.
      const placeholder = await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "⏳ thinking…",
      });
      const progressTs = placeholder.ts;
      if (progressTs === undefined) {
        throw new Error("Slack returned no ts for the progress placeholder");
      }
      let lastUpdate = 0;
      const live = await harness.watchDoc(LiveDoc, conversation.id, context);
      live?.start(async (value) => {
        const now = Date.now();
        if (now - lastUpdate < 1200) {
          return; // chisle: 1.2s throttle keeps us far under Slack rate limits
        }
        lastUpdate = now;
        await client.chat
          .update({
            channel: event.channel,
            ts: progressTs,
            text: liveStatusText(value).slice(0, 3900),
          })
          .catch(() => undefined); // deleted/failed placeholder — stop updating silently
      });

      // requestId dedupes Slack retry deliveries of the same mention.
      const submission = await conversation.submit(
        { type: "input", content: input, whenBusy: "steer", requestId: `slack:${event.ts}` },
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
        channel: event.channel,
        ts: progressTs,
        text: linkifyEmails(reply).slice(0, 3900),
      });
    } catch (error) {
      logger.error(error);
    }
  });

  await slack.start();
  // Bots cannot have a profile status (user-token-only feature), and the green
  // bubble cannot track a Socket Mode connection. The workable combination:
  // always_online: true plus users.setPresence — "auto" on start shows green,
  // "away" on graceful shutdown shows grey. Needs users:write.
  const setStatus = async (online: boolean) =>
    slack.client.users.setPresence({ presence: online ? "auto" : "away" }).catch(() => undefined);
  await setStatus(true);
  return { slack, setStatus };
}
