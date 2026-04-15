// ═══════════════════════════════════════════════════════════
// ShadchanAI — Background Job Scheduler (scaffold)
//
// Minimal in-process scheduler for periodic work. This is a
// stepping stone — when traffic grows, swap the runner for a
// proper queue (BullMQ / Mongo-backed / SQS) without changing
// the job functions themselves.
//
// Design:
//   - Each job is a pure `{ name, intervalMs, run() }` record.
//   - Jobs run sequentially inside a tick to avoid DB stampedes.
//   - Errors are logged and NEVER propagate out of the scheduler.
//   - Stopped gracefully via stop().
// ═══════════════════════════════════════════════════════════

export interface JobDef {
  name: string;
  /** How often to run, in ms. */
  intervalMs: number;
  /** Perform the work. Should complete in under a minute. */
  run: () => Promise<void>;
  /** If set, skip until this time. */
  nextRunAt?: Date;
}

interface RegisteredJob extends JobDef {
  lastRunAt?: Date;
  lastDurationMs?: number;
  lastError?: string;
}

const jobs: RegisteredJob[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

export function registerJob(job: JobDef): void {
  jobs.push({ ...job });
}

export function startJobScheduler(tickMs = 30_000): void {
  if (timer) return;
  timer = setInterval(() => void tick(), tickMs);
  // Run once on boot so jobs don't wait for the first interval
  void tick();
}

export function stopJobScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  const now = Date.now();
  for (const job of jobs) {
    const ready = !job.nextRunAt || job.nextRunAt.getTime() <= now;
    if (!ready) continue;
    const start = Date.now();
    try {
      await job.run();
      job.lastError = undefined;
    } catch (err) {
      job.lastError = (err as Error).message;
      console.error(`[job] '${job.name}' failed:`, err);
    }
    job.lastRunAt = new Date();
    job.lastDurationMs = Date.now() - start;
    job.nextRunAt = new Date(Date.now() + job.intervalMs);
  }
}

/** Snapshot for /api/readiness or admin diagnostics */
export function snapshotJobs(): Array<{
  name: string; intervalMs: number; lastRunAt?: Date; lastDurationMs?: number; lastError?: string;
}> {
  return jobs.map(({ name, intervalMs, lastRunAt, lastDurationMs, lastError }) =>
    ({ name, intervalMs, lastRunAt, lastDurationMs, lastError }));
}
