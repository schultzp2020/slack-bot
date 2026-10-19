// Cross-thread memory: decisions and notes any conversation can record and
// every conversation can recall. Session-scoped, so it is shared by all
// threads and survives restarts — the durable layer that outlives the
// conversation cache (threads retire; memory persists).
//
// Ordering is least-recently-used: recall touches what it returns, remember
// refreshes on write, and eviction drops the least recently used first.
// Items are indexed by the issue keys mentioned in their text; recall accepts
// explicit keys (the caller passes an issue key and its parent epic — the
// model knows the hierarchy from the issue it fetched), and key matches rank
// above substring matches.
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
  section,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { offlineFloors } from "./warden.ts";

// The warden's offline opinion: recall only searches stored notes, remember
// appends to them. So recall skips the classifier when it is down, remember
// holds (fail closed).
offlineFloors.push((tool: string) => {
  if (tool === "recall") {
    return false;
  }
  if (tool === "remember") {
    return true;
  }
  return undefined;
});

// A type alias, not an interface: only aliases satisfy the JsonObject
// constraint of the doc definition.
// eslint-disable-next-line typescript/consistent-type-definitions
export type MemoryItem = {
  at: number;
  lastUsed: number;
  keys: string[];
  text: string;
};

/** Issue keys like PROJ-123, mentioned anywhere in the text. */
export function extractKeys(text: string): string[] {
  return [...new Set(text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])];
}

/**
 * Rank memories for a recall: items matching a requested key (issue, parent
 * epic) first, then query substring matches, each group newest-used first.
 */
export function rankMemories(
  items: readonly MemoryItem[],
  query: string,
  keys: readonly string[] = [],
): MemoryItem[] {
  const needle = query.toLowerCase();
  const wanted = new Set(keys);
  const matches = items.filter(
    (item) =>
      (wanted.size > 0 && item.keys.some((key) => wanted.has(key))) ||
      (needle !== "" && item.text.toLowerCase().includes(needle)),
  );
  return matches
    .sort((a, b) => {
      const aKey = wanted.size > 0 && a.keys.some((key) => wanted.has(key)) ? 1 : 0;
      const bKey = wanted.size > 0 && b.keys.some((key) => wanted.has(key)) ? 1 : 0;
      return bKey - aKey || b.lastUsed - a.lastUsed;
    })
    .slice(0, 20);
}

const Memory = defineDoc<{ items: MemoryItem[] }>({
  kind: "app.memory",
  version: 2,
  scope: "session",
  initial: () => ({ items: [] }),
  migrate: (value, fromVersion) => {
    const old =
      fromVersion < 2 ? ((value as { items?: { at?: number; text?: string }[] }).items ?? []) : [];
    return {
      items: old.map((item) => ({
        at: item.at ?? 0,
        lastUsed: item.at ?? 0,
        keys: extractKeys(item.text ?? ""),
        text: item.text ?? "",
      })),
    };
  },
});

// chisle: api.commit/api.snapshot don't infer under tsgolint inside defineTool generics; structural aliases.
interface MemoryApi {
  commit: <T>(
    change: (tx: { doc: (token: typeof Memory) => Promise<{ items: MemoryItem[] }> }) => T,
    context: unknown,
  ) => Promise<T>;
}
interface MemoryReader {
  snapshot: (
    token: typeof Memory,
    context: unknown,
  ) => Promise<{ items: MemoryItem[] } | undefined>;
}

const MEMORY_CAP = 200;

const remember = defineTool({
  name: "remember",
  description:
    "Record a decision, fact, or note in the shared team memory, readable by every thread. " +
    "Use it whenever a thread lands on a real decision worth keeping.",
  parameters: Type.Object({ text: Type.String() }),
  execute: async (args, api, toolContext) => {
    const memory = api as unknown as MemoryApi;
    const now = Date.now();
    await memory.commit(async (tx) => {
      const doc = await tx.doc(Memory);
      doc.items.push({ at: now, lastUsed: now, keys: extractKeys(args.text), text: args.text });
      // Evict least recently used beyond the cap.
      if (doc.items.length > MEMORY_CAP) {
        doc.items.sort((a, b) => b.lastUsed - a.lastUsed);
        doc.items.length = MEMORY_CAP;
      }
    }, toolContext);
    return { output: [{ type: "text", text: "remembered" }] };
  },
});

const recall = defineTool({
  name: "recall",
  description:
    "Search the shared team memory for past decisions and notes. Pass `keys` for the issue " +
    "at hand and its parent epic (you know the hierarchy from the issue you fetched); key " +
    "matches rank above text matches.",
  parameters: Type.Object({
    query: Type.String(),
    keys: Type.Optional(Type.Array(Type.String())),
  }),
  execute: async (args, api, toolContext) => {
    const reader = api as unknown as MemoryReader;
    const memory = await reader.snapshot(Memory, toolContext);
    const found = rankMemories(memory?.items ?? [], args.query, args.keys ?? []);
    if (found.length > 0) {
      // Touch what we return, so eviction is by least recently used.
      const writer = api as unknown as MemoryApi;
      const touched = new Set(found.map((item) => item.text));
      await writer.commit(async (tx) => {
        const doc = await tx.doc(Memory);
        for (const item of doc.items) {
          if (touched.has(item.text)) {
            item.lastUsed = Date.now();
          }
        }
      }, toolContext);
    }
    return {
      output: [
        {
          type: "text",
          text:
            found.length === 0
              ? "nothing remembered matches"
              : found.map((item) => `- ${item.text}`).join("\n"),
        },
      ],
    };
  },
});

const tools: ToolRegistration[] = [remember, recall];

const extension: Extension = defineExtension({
  name: "memory",
  tools,
  sections: [
    section(
      "memory",
      () =>
        "Team memory is available: use remember to record decisions as they are made, " +
        "and recall to search past decisions (pass the issue key and its parent epic) before re-asking the user.",
    ),
  ],
});

export { extension as default };
