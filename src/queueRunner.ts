// Sequential batch runner. It never runs two jobs at once, and Stop both cancels the current job
// and guarantees that no further job starts.

import type { EncodeResult } from '../electron/types';
import { nextRunnable, type Job } from './queue';

export interface RunnerDeps {
  /** Always returns the latest queue (jobs may have been added, removed or reordered meanwhile). */
  getJobs(): Job[];
  /** Prepares, validates and runs one job. Must resolve (never reject) with the outcome. */
  runJob(job: Job): Promise<EncodeResult>;
  cancelJob(id: string): void;
  onStart(id: string): void;
  onResult(id: string, result: EncodeResult): void;
}

export type RunMode = { kind: 'queue' } | { kind: 'single'; id: string };

export class QueueRunner {
  private stopRequested = false;
  private currentId?: string;
  private active = false;

  constructor(private readonly deps: RunnerDeps) {}

  get running(): boolean { return this.active; }
  get current(): string | undefined { return this.currentId; }
  get stopping(): boolean { return this.active && this.stopRequested; }

  async run(mode: RunMode): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.stopRequested = false;
    const handled = new Set<string>();
    try {
      while (!this.stopRequested) {
        const jobs = this.deps.getJobs();
        const job = mode.kind === 'single'
          ? (handled.size === 0 ? jobs.find(j => j.id === mode.id && nextRunnable([j], handled)) : undefined)
          : nextRunnable(jobs, handled);
        if (!job) break;
        handled.add(job.id);
        this.currentId = job.id;
        this.deps.onStart(job.id);
        let result: EncodeResult;
        try {
          result = await this.deps.runJob(job);
        } catch (error) {
          result = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
        }
        this.currentId = undefined;
        this.deps.onResult(job.id, result);
        // Give the UI a chance to publish the result before the next pick.
        await Promise.resolve();
      }
    } finally {
      this.active = false;
      this.stopRequested = false;
      this.currentId = undefined;
    }
  }

  /** Cancels the running job (if any) and prevents every remaining job from starting. */
  stop(): void {
    if (!this.active) return;
    this.stopRequested = true;
    if (this.currentId) this.deps.cancelJob(this.currentId);
  }
}
