// Thread-state interface tests: open, mark seen, recovery cursors, and
// retirement, through the module's own seam (a real Harness over a temp
// SQLite file) — not its internal documents.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRuntimeModels, createRuntimeRegistry, context } from "../src/harness.ts";
import {
  markThreadSeen,
  openThread,
  recoveryThreadCursors,
  retireStaleThreads,
  threadLastSeenTs,
} from "../src/threads.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function openHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "threads-"));
  dirs.push(dir);
  const storage = await openNodeSqliteStorage(join(dir, "session.sqlite"));
  return Harness.open(
    storage,
    { models: createRuntimeModels(), registry: await createRuntimeRegistry() },
    context,
  );
}

// An ancient Slack ts (epoch-adjacent seconds) so TTL retirement sees it stale.
const ANCIENT_TS = "1000.000000";

describe("thread state", () => {
  it("opens one conversation per thread and reopens the same one", async () => {
    const harness = await openHarness();
    const first = await openThread(harness, "C1", "100.1");
    const again = await openThread(harness, "C1", "100.1");
    expect(again.id).toBe(first.id);
    const other = await openThread(harness, "C1", "200.2");
    expect(other.id).not.toBe(first.id);
    await harness.close(context);
  });

  it("markThreadSeen advances lastSeen and the recovery cursor", async () => {
    const harness = await openHarness();
    await openThread(harness, "C1", ANCIENT_TS);
    // Before any reconcile, the cursor falls back to the thread's last use.
    let cursors = await recoveryThreadCursors(harness);
    expect(cursors).toEqual([{ channel: "C1", threadTs: ANCIENT_TS, since: ANCIENT_TS }]);
    await markThreadSeen(harness, "C1", ANCIENT_TS, "105.5");
    expect(await threadLastSeenTs(harness, "C1", ANCIENT_TS)).toBe("105.5");
    cursors = await recoveryThreadCursors(harness);
    expect(cursors).toEqual([{ channel: "C1", threadTs: ANCIENT_TS, since: "105.5" }]);
    await harness.close(context);
  });

  it("retires idle threads; the next open starts a fresh conversation", async () => {
    const harness = await openHarness();
    const first = await openThread(harness, "C1", ANCIENT_TS);
    // A thread touched "now" is not idle.
    const nowTs = `${Date.now() / 1000}`;
    await openThread(harness, "C2", nowTs);
    const retired = await retireStaleThreads(harness, 60_000);
    expect(retired).toBe(1);
    expect(await threadLastSeenTs(harness, "C1", ANCIENT_TS)).toBe("0"); // mapping gone
    expect((await recoveryThreadCursors(harness)).map((c) => c.channel)).toEqual(["C2"]);
    const fresh = await openThread(harness, "C1", ANCIENT_TS);
    expect(fresh.id).not.toBe(first.id);
    await harness.close(context);
  });
});
