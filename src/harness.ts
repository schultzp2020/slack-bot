// pi-durable wiring: model gateway access, the jira tool, and one durable
// conversation per Slack thread (mapped in a session-scoped doc family).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { readdirSync } from "node:fs";
import {
  createRegistry,
  defineDoc,
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

// Per-channel watermark of the newest message this bot has processed; the
// startup recovery sweep resumes from it, so mentions that arrive while the
// bot is down are answered after restart.
const Channels = defineDoc<{ seen: Record<string, string> }>({
  kind: "app.channels",
  version: 1,
  scope: "session",
  initial: () => ({ seen: {} }),
});

// chisle: session-doc tokens don't infer under tsgolint here; structural aliases, as in memory.ts.
interface ChannelsWriter {
  doc: (token: typeof Channels) => Promise<{ seen: Record<string, string> }>;
}
interface ChannelsReader {
  snapshot: (
    token: typeof Channels,
    ctx: typeof context,
  ) => Promise<{ seen: Record<string, string> } | undefined>;
}

export async function markChannelSeen(
  harness: Harness,
  channel: string,
  ts: string,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await (tx as unknown as ChannelsWriter).doc(Channels);
    // Max-merge: a stale writer (e.g. recovery of an older event) must never
    // move the frontier backwards.
    if (ts > (doc.seen[channel] ?? "0")) {
      doc.seen[channel] = ts;
    }
  }, context);
}

export async function channelWatermarks(harness: Harness): Promise<Record<string, string>> {
  const reader = harness as unknown as ChannelsReader;
  return (await reader.snapshot(Channels, context))?.seen ?? {};
}

// Index of thread keys by last use, so stale threads can be enumerated and
// retired: conversations are a cache, team memory is the truth layer. Retiring
// the mapping means the next ping starts a fresh conversation; the old one
// stays in SQLite as an audit trail.
const ThreadIndex = defineDoc<{ used: Record<string, string> }>({
  kind: "app.thread_index",
  version: 1,
  scope: "session",
  initial: () => ({ used: {} }),
});

// chisle: session-doc tokens don't infer under tsgolint here; structural aliases, as in memory.ts.
interface ThreadIndexWriter {
  doc: (token: typeof ThreadIndex) => Promise<{ used: Record<string, string> }>;
}
interface ThreadIndexRetirer {
  retireDoc: (token: unknown, key: string) => Promise<void>;
}
interface ThreadIndexReader {
  snapshot: (
    token: typeof ThreadIndex,
    ctx: typeof context,
  ) => Promise<{ used: Record<string, string> } | undefined>;
}

/** A Slack message ts ("seconds.microseconds") as epoch milliseconds. */
export function tsToMs(ts: string): number {
  return Math.floor(Number(ts) * 1000);
}

/** Thread keys not used within the TTL. */
export function staleThreadKeys(
  used: Record<string, string>,
  nowMs: number,
  ttlMs: number,
): string[] {
  return Object.entries(used)
    .filter(([, ts]) => {
      const ms = tsToMs(ts);
      return Number.isFinite(ms) && ms > 0 && nowMs - ms > ttlMs;
    })
    .map(([key]) => key);
}

/** Retire thread mappings idle beyond the TTL; returns how many were retired. */
export async function retireStaleThreads(harness: Harness, ttlMs: number): Promise<number> {
  const reader = harness as unknown as ThreadIndexReader;
  const used = (await reader.snapshot(ThreadIndex, context))?.used ?? {};
  const candidates = new Set(staleThreadKeys(used, Date.now(), ttlMs));
  if (candidates.size === 0) {
    return 0;
  }
  let retired = 0;
  await harness.commit(async (tx) => {
    const index = await (tx as unknown as ThreadIndexWriter).doc(ThreadIndex);
    const retirer = tx as unknown as ThreadIndexRetirer;
    for (const key of candidates) {
      // Recheck inside the transaction: a turn that refreshed this thread
      // since our snapshot must not have its mapping pulled out from under it.
      if (!(key in index.used)) {
        continue; // already retired by an earlier sweep
      }
      if (staleThreadKeys({ [key]: index.used[key] }, Date.now(), ttlMs).length === 0) {
        continue; // refreshed since our snapshot
      }
      await retirer.retireDoc(Threads, key);
      delete index.used[key];
      retired++;
    }
  }, context);
  return retired;
}

/** Snapshot of the thread index: threadKey -> last-used ts. */
export async function threadIndexSnapshot(harness: Harness): Promise<Record<string, string>> {
  const reader = harness as unknown as ThreadIndexReader;
  return (await reader.snapshot(ThreadIndex, context))?.used ?? {};
}

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
    const key = threadKey(channel, threadTs);
    const thread = await tx.doc(Threads, key, { channel });
    thread.lastSeenTs = ts;
    (await (tx as unknown as ThreadIndexWriter).doc(ThreadIndex)).used[key] = ts;
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
    // Refresh the index here too: acquiring a conversation means the thread
    // is in active use, so retirement (which rechecks in-transaction) will
    // not pull the mapping out from under a running turn.
    (await (tx as unknown as ThreadIndexWriter).doc(ThreadIndex)).used[key] = threadTs;
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
