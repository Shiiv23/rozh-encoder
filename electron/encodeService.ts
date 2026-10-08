// Owns the running FFmpeg process, one at a time. Kept free of Electron imports so it can be unit tested.

import type { EncodeController, EncodeOutcome } from './media';
import { hasErrors, validateEncode } from './rules';
import type { EncodeResult, EncodeSettings, FfmpegStatus, MediaInfo, ProgressInfo } from './types';

export interface EncodeServiceDeps {
  detect(): Promise<FfmpegStatus>;
  inspect(file: string): Promise<MediaInfo>;
  startEncoding(settings: EncodeSettings, media: MediaInfo, onProgress: (info: ProgressInfo) => void): EncodeController;
  /** Persists the log and returns its path (undefined if it could not be written). */
  writeLog(jobId: string, text: string): Promise<string | undefined>;
}

export class EncodeService {
  private active?: { jobId: string; controller: EncodeController };
  private starting = false;

  constructor(private readonly deps: EncodeServiceDeps) {}

  get busy(): boolean { return this.active !== undefined || this.starting; }

  cancel(jobId: string): boolean {
    if (!this.active || this.active.jobId !== jobId) return false;
    this.active.controller.cancel();
    return true;
  }

  async start(jobId: string, settings: EncodeSettings, onProgress: (info: ProgressInfo) => void): Promise<EncodeResult> {
    if (this.busy) return { status: 'failed', error: 'Another encode is already running. Rozh encodes one file at a time.' };
    this.starting = true;
    let controller: EncodeController;
    let media: MediaInfo;
    try {
      const status = await this.deps.detect();
      if (!status.available) return { status: 'failed', error: status.problem ?? 'FFmpeg is not available.' };
      // Re-read the file: it may have changed since it was added to the queue.
      media = await this.deps.inspect(settings.input);
      const issues = validateEncode(settings, media, status.encoders);
      if (hasErrors(issues)) {
        return { status: 'failed', error: issues.filter(i => i.level === 'error').map(i => i.message).join(' ') };
      }
      controller = this.deps.startEncoding(settings, media, onProgress);
      this.active = { jobId, controller };
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.starting = false;
    }

    let outcome: EncodeOutcome;
    try {
      outcome = await controller.done;
    } finally {
      this.active = undefined;
    }
    const logPath = await this.deps.writeLog(jobId, outcome.log).catch(() => undefined);
    const { log: _log, command: _command, ...result } = outcome;
    return { ...result, logPath } as EncodeResult;
  }
}
