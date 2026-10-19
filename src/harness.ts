// pi-durable wiring: model gateway access, the jira tool, and one durable
// conversation per Slack thread (mapped in a session-scoped doc family).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { readdirSync } from "node:fs";
import {
  createRegistry,
  defineDocFamily,
  type Conversation,
  type ConversationId,
  type Extension,
  type Harness,
} from "@earendil-works/pi-durable";
import {
  MODEL_BASE_URL,
  MODEL_CONTEXT_WINDOW,
  MODEL_ID,
  MODEL_MAX_TOKENS,
  MODEL_NAME,
  MODEL_REASONING,
  SYSTEM_PROMPT,
} from "./config.ts";
import { threadKey } from "./util.ts";

export const context = BACKGROUND_CONTEXT;

// --- Model access: OpenAI-compatible gateway -----------------------------

const gateway = createProvider({
  id: "gateway",
  name: "Model gateway",
  baseUrl: MODEL_BASE_URL,
  auth: {
    apiKey: {
      name: "Model gateway API key",
      resolve: () => {
        const apiKey = process.env.MODEL_API_KEY;
        return Promise.resolve(
          apiKey === undefined ? undefined : { auth: { apiKey }, source: "MODEL_API_KEY" },
        );
      },
    },
  },
  api: openAICompletionsApi(),
  models: [
    {
      id: MODEL_ID,
      name: MODEL_NAME,
      api: "openai-completions",
      provider: "gateway",
      baseUrl: MODEL_BASE_URL,
      input: ["text"],
      reasoning: MODEL_REASONING,
      contextWindow: MODEL_CONTEXT_WINDOW,
      maxTokens: MODEL_MAX_TOKENS,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false },
    },
  ],
});

export function createRuntimeModels() {
  const models = createModels();
  models.setProvider(gateway);
  return models;
}

/**
 * Create the runtime registry. Extensions are discovered, not listed: every
 * src/extensions/*.ts module default-exports an Extension and is installed
 * here. Installing is the only registration step — conversations enable every
 * registered tool by default (AgentChange.tools unset).
 */
export async function createRuntimeRegistry() {
  const registry = createRegistry();
  const dir = new URL("extensions/", import.meta.url);
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .sort();
  for (const file of files) {
    const module = (await import(new URL(file, dir).href)) as { default?: Extension };
    if (module.default !== undefined) {
      registry.install(module.default);
    }
  }
  return registry;
}

// --- Slack thread -> durable conversation map ----------------------------

const Threads = defineDocFamily<
  { conversationId: number; channel: string; lastSeenTs: string },
  { channel: string }
>({
  kind: "app.slack_threads",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({ conversationId: 0, channel: seed.channel, lastSeenTs: "0" }),
});

export async function threadLastSeenTs(
  harness: Harness,
  channel: string,
  threadTs: string,
): Promise<string> {
  const thread = await harness.snapshot(Threads, threadKey(channel, threadTs), context);
  return thread?.lastSeenTs ?? "0";
}

export async function markThreadSeen(
  harness: Harness,
  channel: string,
  threadTs: string,
  ts: string,
): Promise<void> {
  await harness.commit(async (tx) => {
    const thread = await tx.doc(Threads, threadKey(channel, threadTs), { channel });
    thread.lastSeenTs = ts;
  }, context);
}

export async function threadConversation(
  harness: Harness,
  channel: string,
  threadTs: string,
): Promise<Conversation> {
  const key = threadKey(channel, threadTs);
  const id = await harness.commit(async (tx) => {
    const thread = await tx.doc(Threads, key, { channel });
    if (thread.conversationId !== 0) {
      return thread.conversationId as ConversationId;
    }
    const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
    thread.conversationId = created.id;
    return created.id;
  }, context);
  const conversation = await harness.conversation(id, context);
  if (!conversation) {
    throw new Error(`conversation ${id} missing after commit`);
  }
  // tx.createConversation takes only ownership; agent choices go through configure().
  // Idempotent: an equal value records no change, so this also self-heals older conversations.
  // tools left unset: every tool of every installed extension is enabled.
  await conversation.configure(
    { model: { provider: "gateway", modelId: MODEL_ID }, instructions: SYSTEM_PROMPT },
    context,
  );
  return conversation;
}
