// Thread state: the Slack-thread -> durable-conversation map, its LRU index,
// channel watermarks' thread side, and retirement. One module owns every fact
// about how threads persist: key encoding, the index doc, cursor fallback,
// and conversation acquisition. Callers (turn, recovery, schedules) see only
// behavioral operations — open, mark seen, cursors, retire.
import {
  defineDoc,
  defineDocFamily,
  type Conversation,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import { MODEL_ID, SYSTEM_PROMPT } from "./config.ts";
import { context } from "./harness.ts";
import { threadKey } from "./util.ts";

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

// Index of thread keys by last use, so stale threads can be enumerated and
// retired: conversations are a cache, team memory is the truth layer.
const ThreadIndex = defineDoc<{ used: Record<string, string> }>({
  kind: "app.thread_index",
  version: 1,
  scope: "session",
  initial: () => ({ used: {} }),
});

// chisle: session-doc tokens don't infer under tsgolint; structural aliases.
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

/** The thread's conversation: acquired (created on first use) and configured. */
export async function openThread(
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

/** The newest ts this thread has seen (its replies reconcile from here). */
export async function threadLastSeenTs(
  harness: Harness,
  channel: string,
  threadTs: string,
): Promise<string> {
  const thread = await harness.snapshot(Threads, threadKey(channel, threadTs), context);
  return thread?.lastSeenTs ?? "0";
}

/** Record that the thread has been seen up to `ts`. */
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

export interface ThreadCursor {
  channel: string;
  threadTs: string;
  /** Replies strictly after this ts are unrecovered. */
  since: string;
}

/**
 * Recovery cursors for every mapped thread: the thread's last-seen ts, falling
 * back to the index's last-used ts when the thread was opened but never
 * reconciled.
 */
export async function recoveryThreadCursors(harness: Harness): Promise<ThreadCursor[]> {
  const reader = harness as unknown as ThreadIndexReader;
  const used = (await reader.snapshot(ThreadIndex, context))?.used ?? {};
  const cursors: ThreadCursor[] = [];
  for (const [key, lastUsed] of Object.entries(used)) {
    const [channel, threadTs] = key.split(":");
    if (channel === "" || threadTs === "" || !key.includes(":")) {
      continue; // malformed key; threadKey always produces channel:ts
    }
    const lastSeen = await threadLastSeenTs(harness, channel, threadTs);
    cursors.push({ channel, threadTs, since: lastSeen > "0" ? lastSeen : lastUsed });
  }
  return cursors;
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
