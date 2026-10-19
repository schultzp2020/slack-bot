// Scheduled turns: config.yaml declares a name, a daily time, a channel, and
// a prompt. Runs are tracked in a session doc, so a schedule missed while the
// bot was down is caught up on startup — the durable effect of a cron, without
// a cron process.
import { defineDoc } from "@earendil-works/pi-durable";
import type { ScheduleConfig } from "./config.ts";
import { THREAD_TTL_MS } from "./config.ts";
import { context, retireStaleThreads } from "./harness.ts";
import { runTurn, type TurnDeps } from "./turn.ts";

const Schedules = defineDoc<{ lastRun: Record<string, number> }>({
  kind: "app.schedules",
  version: 1,
  scope: "session",
  initial: () => ({ lastRun: {} }),
});

/** Epoch ms of today's scheduled run for a `daily_at` HH:MM (server local time). */
export function dueTodayMs(dailyAt: string, now: Date): number {
  const [hours, minutes] = dailyAt.split(":").map(Number);
  const date = new Date(now);
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}

/** Due when the daily time has passed and this run has not happened yet. */
export function isDue(
  schedule: ScheduleConfig,
  lastRunMs: number | undefined,
  now: number,
): boolean {
  const due = dueTodayMs(schedule.daily_at, new Date(now));
  return now >= due && (lastRunMs ?? 0) < due;
}

async function runSchedule(deps: TurnDeps, schedule: ScheduleConfig, due: number): Promise<void> {
  const { harness } = deps;
  await runTurn(deps, {
    channel: schedule.channel,
    text: schedule.prompt,
    rawText: "",
    requestId: `schedule:${schedule.name}:${Math.floor(due / 86_400_000)}`,
  });
  await harness.commit(async (tx) => {
    (await tx.doc(Schedules)).lastRun[schedule.name] = Date.now();
  }, context);
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
    for (const schedule of schedules) {
      const due = dueTodayMs(schedule.daily_at, new Date());
      if (!isDue(schedule, lastRun[schedule.name], Date.now())) {
        continue;
      }
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
