// Scheduled turns: config.yaml declares a name, a daily time, a channel, and
// a prompt. Runs are tracked in a session doc, so a schedule missed while the
// bot was down is caught up on startup — the durable effect of a cron, without
// a cron process. Occurrences are claimed atomically BEFORE the turn runs: a
// crash after the claim skips that occurrence (never double-runs its effects).
import { defineDoc } from "@earendil-works/pi-durable";
import type { ScheduleConfig } from "./config.ts";
import { THREAD_TTL_MS } from "./config.ts";
import { context } from "./harness.ts";
import { retireStaleThreads } from "./threads.ts";
import { runTurn, type TurnDeps } from "./turn.ts";

const Schedules = defineDoc<{ lastRun: Record<string, number> }>({
  kind: "app.schedules",
  version: 1,
  scope: "session",
  initial: () => ({ lastRun: {} }),
});

/**
 * Epoch ms of the latest scheduled occurrence at or before `now` for a
 * `daily_at` HH:MM (server local time): today's time if it has passed,
 * otherwise yesterday's — so a run missed across a downtime boundary is
 * still caught up.
 */
export function lastOccurrenceMs(dailyAt: string, now: Date): number {
  const [hours, minutes] = dailyAt.split(":").map(Number);
  const date = new Date(now);
  date.setHours(hours, minutes, 0, 0);
  if (date.getTime() > now.getTime()) {
    date.setDate(date.getDate() - 1);
  }
  return date.getTime();
}

/** Due when the latest occurrence has passed and has not run yet. */
export function isDue(
  schedule: ScheduleConfig,
  lastRunMs: number | undefined,
  now: number,
): boolean {
  const due = lastOccurrenceMs(schedule.daily_at, new Date(now));
  return (lastRunMs ?? 0) < due;
}

/**
 * Claim the occurrence for this schedule (one atomic commit) and run it.
 * Returns false when another tick already claimed it.
 */
async function runSchedule(
  deps: TurnDeps,
  schedule: ScheduleConfig,
  due: number,
): Promise<boolean> {
  const { harness } = deps;
  // Claim in one atomic commit; the change fn's return value says whether we
  // won the claim (another tick may have taken it first).
  const claimed = await harness.commit(async (tx) => {
    const doc = await tx.doc(Schedules);
    if ((doc.lastRun[schedule.name] ?? 0) < due) {
      doc.lastRun[schedule.name] = due;
      return true;
    }
    return false;
  }, context);
  if (!claimed) {
    return false;
  }
  await runTurn(deps, {
    channel: schedule.channel,
    text: schedule.prompt,
    // Deterministic per occurrence: a crash after the claim does not re-run
    // (claimed), and the same occurrence never runs twice.
    requestId: `schedule:${schedule.name}:${Math.floor(due / 86_400_000)}`,
  });
  return true;
}

/**
 * Check schedules now and every hour. Late runs (the bot was down at the
 * scheduled time) run immediately on the first tick after startup.
 */
export function startSchedules(deps: TurnDeps, schedules: readonly ScheduleConfig[]): () => void {
  const { harness } = deps;
  const tick = async () => {
    // Conversations are a cache: retire threads idle beyond the TTL.
    try {
      await retireStaleThreads(harness, THREAD_TTL_MS);
    } catch (error) {
      console.error("thread retirement failed:", error);
    }
    const lastRun = (await harness.snapshot(Schedules, context))?.lastRun ?? {};
    const now = Date.now();
    for (const schedule of schedules) {
      if (!isDue(schedule, lastRun[schedule.name], now)) {
        continue;
      }
      const due = lastOccurrenceMs(schedule.daily_at, new Date(now));
      try {
        await runSchedule(deps, schedule, due);
      } catch (error) {
        console.error(`schedule ${schedule.name} failed:`, error);
      }
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 60 * 60 * 1000);
  return () => clearInterval(timer);
}
