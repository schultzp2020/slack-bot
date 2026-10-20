// Slack transport: Bolt Socket Mode. Mentions, slash commands, presence.
import type { AppMentionEvent } from "@slack/types";
import { App } from "@slack/bolt";
import type { Harness } from "@earendil-works/pi-durable";
import { COMMANDS, type CommandConfig } from "./config.ts";
import { context } from "./harness.ts";
import { runMention, runTurn, type SlackClient, type TurnDeps } from "./turn.ts";

// chisle: Bolt's listener-arg generics don't resolve under oxlint's type checker; typed structurally instead.
interface CommandArgs {
  ack: () => Promise<void>;
  command: {
    command: string;
    text: string;
    channel_id: string;
    user_id: string;
    trigger_id: string;
  };
  client: { chat: { postMessage: (args: { channel: string; text: string }) => Promise<unknown> } };
  logger: { error: (error: unknown) => void };
}

/** Register one slash command with a single typed dispatcher shape. */
function registerCommand(
  slack: App,
  name: string,
  handler: (args: CommandArgs) => Promise<void>,
): void {
  slack.command(name, async (rawArgs: unknown) => {
    const args = rawArgs as CommandArgs;
    const { ack, logger } = args;
    await ack();
    try {
      await handler(args);
    } catch (error) {
      logger.error(error);
    }
  });
}

/** A configured command: run its preset prompt in a new thread. */
async function handleConfiguredCommand(
  deps: TurnDeps,
  command: CommandConfig,
  args: CommandArgs,
): Promise<void> {
  const cmd = args.command;
  const content =
    command.prompt !== undefined
      ? `${command.prompt}

${cmd.text}`.trim()
      : cmd.text;
  await runTurn(deps, {
    channel: cmd.channel_id,
    text: content,
    requestId: `cmd:${cmd.trigger_id}`,
    placeholderPrefix: `/${command.name} ${cmd.text}
`,
    requesterUserId: cmd.user_id,
  });
}

/** /stats logic, at module scope so no Bolt generic inference is involved. */
async function handleStatsCommand(harness: Harness, args: CommandArgs): Promise<void> {
  const { command: cmd, client } = args;
  const usage = await harness.usage(context);
  const lines = Object.entries(usage.models).map(
    ([model, u]) =>
      `• ${model}: ${u.totalTokens} tokens (in ${u.input} / out ${u.output}), cost ${u.cost.total}`,
  );
  await client.chat.postMessage({
    channel: cmd.channel_id,
    text: lines.length > 0 ? `Usage:\n${lines.join("\n")}` : "No usage recorded yet.",
  });
}

/** Build the Slack app and its deps without connecting yet. Listeners are
 * registered here; call `slack.start()` (then setStatus(true)) once startup
 * work that must not race live traffic — the recovery sweep — is done. */
export async function createSlackApp(
  harness: Harness,
): Promise<{ slack: App; setStatus: (online: boolean) => Promise<unknown>; deps: TurnDeps }> {
  const slack = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  const auth = await slack.client.auth.test();
  const botUserId = auth.user_id ?? "";
  const deps: TurnDeps = {
    harness,
    // chisle: bolt's WebClient satisfies this structurally, but the union of
    // overloads degrades under tsgolint; the cast is load-bearing.
    client: slack.client as unknown as SlackClient,
    botUserId,
  };

  slack.event("app_mention", async (args) => {
    const { event, logger } = args as unknown as {
      event: AppMentionEvent;
      logger: { error: (error: unknown) => void };
    };
    try {
      if (event.user === undefined) {
        return; // bot or system message
      }
      await runMention(deps, {
        channel: event.channel,
        ts: event.ts,
        ...(event.thread_ts !== undefined ? { thread_ts: event.thread_ts } : {}),
        text: event.text,
        user: event.user,
      });
    } catch (error) {
      logger.error(error);
    }
  });

  // /stats: usage and cost totals from the durable records.
  registerCommand(slack, "/stats", (args) => handleStatsCommand(harness, args));

  // Configured commands: /name [text] runs a preset prompt in a new thread.
  for (const command of COMMANDS) {
    registerCommand(slack, `/${command.name}`, (args) =>
      handleConfiguredCommand(deps, command, args),
    );
  }

  // Bots cannot have a profile status (user-token-only feature), and the green
  // bubble cannot track a Socket Mode connection. The workable combination:
  // always_online: true plus users.setPresence — "auto" on start shows green,
  // "away" on graceful shutdown shows grey. Needs users:write.
  const setStatus = async (online: boolean) =>
    slack.client.users.setPresence({ presence: online ? "auto" : "away" }).catch(() => undefined);

  return { slack, setStatus, deps };
}
