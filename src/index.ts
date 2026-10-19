// Entry point: open the durable Harness over SQLite, resume unfinished work,
// and start the Slack relay.
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRuntimeModels, createRuntimeRegistry, context } from "./harness.ts";
import { startSlackApp } from "./slack.ts";

// pi-durable mints record IDs from an in-process counter with no cross-process
// locking: a second live bot on the same SQLite file corrupts commits. This
// lock makes "one process owns the storage" an invariant we enforce.
function acquireSingleInstanceLock(): void {
  mkdirSync("data", { recursive: true });
  const lockPath = "data/bot.lock";
  let pid = Number.NaN;
  try {
    pid = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
  } catch {
    pid = Number.NaN; // no lock file yet
  }
  if (Number.isInteger(pid)) {
    try {
      process.kill(pid, 0); // throws ESRCH if dead, EPERM if alive but restricted
      console.error(`another slack-bot (pid ${pid}) holds ${lockPath}; not starting`);
      process.exit(1);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        throw error; // EPERM: alive; anything else: unexpected
      }
    }
  }
  writeFileSync(lockPath, `${process.pid}`);
}

export async function main() {
  acquireSingleInstanceLock();
  mkdirSync("data", { recursive: true });
  const storage = await openNodeSqliteStorage("data/session.sqlite");
  const harness = await Harness.open(
    storage,
    { models: createRuntimeModels(), registry: await createRuntimeRegistry() },
    context,
  );
  harness.resume(); // continue runs the last process left unfinished

  const { setStatus } = await startSlackApp(harness);
  console.log("slack-bot up (socket mode, pi-durable harness)");

  const shutdown = async () => {
    await setStatus(false);
    await harness.close(context);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

await main();
