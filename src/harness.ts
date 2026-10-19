// pi-durable wiring: model gateway access, the jira tool, and one durable
// conversation per Slack thread (mapped in a session-scoped doc family).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { readdirSync } from "node:fs";
import {
  createRegistry,
  defineDoc,
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
} from "./config.ts";

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
