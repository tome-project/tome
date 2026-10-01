/** Completion-based scheduling keeps slow database work from overlapping. */
export interface JobClock {
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface BackgroundJobOptions {
  name: string;
  run(signal: AbortSignal): Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  maxBackoffMs?: number;
  immediate?: boolean;
  clock?: JobClock;
  report?: (message: string) => void;
}

export function startBackgroundJob(options: BackgroundJobOptions): () => void {
  const clock = options.clock ?? { setTimeout, clearTimeout };
  const interval = options.intervalMs ?? 60_000;
  const deadline = options.timeoutMs ?? 15_000;
  const maximum = options.maxBackoffMs ?? 15 * 60_000;
  const report = options.report ?? console.log;
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  function schedule(delay: number): void {
    if (!stopped) timer = clock.setTimeout(() => void tick(), delay);
  }

  async function tick(): Promise<void> {
    timer = undefined;
    if (stopped) return;
    controller = new AbortController();
    const active = controller;
    const timeout = clock.setTimeout(() => active.abort(), deadline);
    let delay = interval;
    try {
      await options.run(active.signal);
      // A task that absorbs its abort must still enter outage backoff.
      active.signal.throwIfAborted();
      if (failures) report(`[background:${options.name}] recovered; next run in ${interval / 1000}s`);
      failures = 0;
    } catch {
      failures += 1;
      delay = Math.min(maximum, interval * 2 ** Math.min(failures - 1, 20));
      if (!stopped) report(`[background:${options.name}] failed (${failures}); next run in ${delay / 1000}s`);
    } finally {
      clock.clearTimeout(timeout);
      controller = undefined;
      // Do not race the task against its deadline: await cancellation settling
      // before scheduling another run, even if the task ignores its signal.
      schedule(delay);
    }
  }

  schedule(options.immediate ? 0 : interval);
  return () => {
    stopped = true;
    if (timer !== undefined) clock.clearTimeout(timer);
    controller?.abort();
  };
}
