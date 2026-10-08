// Pure queue state: no React, no Electron. Everything the batch table does is decided here and unit tested.

import type { EncodeResult, JobStatus, MediaInfo, ProgressInfo } from '../electron/types';
import { basename } from '../electron/paths';

export interface Job {
  id: string;
  input: string;
  name: string;
  status: JobStatus;
  media?: MediaInfo;
  /** Where the encoded file will be written. Planned automatically unless `outputChosen`. */
  output?: string;
  /** The user picked this exact file in a save dialog. */
  outputChosen: boolean;
  /** Only ever true when the user confirmed replacing an existing file in the save dialog. */
  overwrite: boolean;
  externalSubtitle?: string;
  keepSubtitles?: number[];
  burnStream?: number;
  /** Seconds from the start of the source to begin encoding at. */
  trimStartSec?: number;
  /** Seconds from the start of the source to stop encoding at. */
  trimEndSec?: number;
  progress?: ProgressInfo;
  error?: string;
  detail?: string;
  logPath?: string;
}

export type Action =
  | { type: 'add'; items: Array<{ id: string; input: string }> }
  | { type: 'analyzing'; id: string }
  | { type: 'analyzed'; id: string; media: MediaInfo }
  | { type: 'analysisFailed'; id: string; error: string }
  | { type: 'remove'; id: string }
  | { type: 'move'; id: string; delta: -1 | 1 }
  | { type: 'setOutput'; id: string; output: string; chosen: boolean; overwrite: boolean }
  | { type: 'setPlanned'; outputs: Record<string, string> }
  | { type: 'unchooseOutputs'; ids: string[] }
  | { type: 'setSubtitle'; id: string; patch: { externalSubtitle?: string | null; keepSubtitles?: number[] | null; burnStream?: number | null } }
  | { type: 'setTrim'; id: string; patch: { startSec?: number | null; endSec?: number | null } }
  | { type: 'encoding'; id: string }
  | { type: 'progress'; id: string; info: ProgressInfo }
  | { type: 'finished'; id: string; result: EncodeResult }
  | { type: 'reset'; id: string }
  | { type: 'clearCompleted' };

/** A job that has been analysed but not finished can be edited and (re)started. */
export const isStartable = (job: Job) => job.status === 'ready' && !!job.media;
export const isBusy = (job: Job) => job.status === 'encoding';
export const canRemove = (job: Job) => job.status !== 'encoding';
export const canReset = (job: Job) => job.status === 'failed' || job.status === 'cancelled' || job.status === 'complete';
/** Output and per-file subtitle choices can change until the job has started. */
export const isEditable = (job: Job) => job.status !== 'encoding';

export function nextPending(jobs: Job[]): Job | undefined {
  return jobs.find(j => j.status === 'pending');
}

/** First startable job in queue order that has not already been handled in this run. */
export function nextRunnable(jobs: Job[], done: ReadonlySet<string>): Job | undefined {
  return jobs.find(j => isStartable(j) && !done.has(j.id));
}

export function canMove(jobs: Job[], id: string, delta: -1 | 1): boolean {
  const i = jobs.findIndex(j => j.id === id);
  return i >= 0 && i + delta >= 0 && i + delta < jobs.length;
}

export function counts(jobs: Job[]): Record<JobStatus, number> {
  const result: Record<JobStatus, number> = { pending: 0, analyzing: 0, ready: 0, encoding: 0, complete: 0, failed: 0, cancelled: 0 };
  for (const job of jobs) result[job.status]++;
  return result;
}

const patchJob = (jobs: Job[], id: string, fn: (job: Job) => Job): Job[] => jobs.map(j => (j.id === id ? fn(j) : j));

export function queueReducer(jobs: Job[], action: Action): Job[] {
  switch (action.type) {
    case 'add':
      return [...jobs, ...action.items.map((item): Job => ({ id: item.id, input: item.input, name: basename(item.input), status: 'pending', outputChosen: false, overwrite: false }))];
    case 'analyzing':
      return patchJob(jobs, action.id, j => (j.status === 'pending' ? { ...j, status: 'analyzing' } : j));
    case 'analyzed':
      return patchJob(jobs, action.id, j => ({ ...j, status: 'ready', media: action.media, error: undefined }));
    case 'analysisFailed':
      return patchJob(jobs, action.id, j => ({ ...j, status: 'failed', error: action.error }));
    case 'remove':
      return jobs.filter(j => j.id !== action.id || !canRemove(j));
    case 'move': {
      const i = jobs.findIndex(j => j.id === action.id);
      const k = i + action.delta;
      if (i < 0 || k < 0 || k >= jobs.length) return jobs;
      const next = jobs.slice();
      [next[i], next[k]] = [next[k], next[i]];
      return next;
    }
    case 'setOutput':
      return patchJob(jobs, action.id, j => (isEditable(j) ? { ...j, output: action.output, outputChosen: action.chosen, overwrite: action.overwrite } : j));
    case 'setPlanned':
      return jobs.map(j => (!j.outputChosen && isEditable(j) && j.status !== 'complete' && action.outputs[j.id] ? { ...j, output: action.outputs[j.id] } : j));
    case 'unchooseOutputs':
      return jobs.map(j => (action.ids.includes(j.id) && isEditable(j) ? { ...j, outputChosen: false, overwrite: false, output: undefined } : j));
    case 'setSubtitle':
      return patchJob(jobs, action.id, j => {
        if (!isEditable(j)) return j;
        const { externalSubtitle, keepSubtitles, burnStream } = action.patch;
        return {
          ...j,
          externalSubtitle: externalSubtitle === undefined ? j.externalSubtitle : externalSubtitle ?? undefined,
          keepSubtitles: keepSubtitles === undefined ? j.keepSubtitles : keepSubtitles ?? undefined,
          burnStream: burnStream === undefined ? j.burnStream : burnStream ?? undefined
        };
      });
    case 'setTrim':
      return patchJob(jobs, action.id, j => {
        if (!isEditable(j)) return j;
        const { startSec, endSec } = action.patch;
        return {
          ...j,
          trimStartSec: startSec === undefined ? j.trimStartSec : startSec ?? undefined,
          trimEndSec: endSec === undefined ? j.trimEndSec : endSec ?? undefined
        };
      });
    case 'encoding':
      return patchJob(jobs, action.id, j => ({ ...j, status: 'encoding', progress: undefined, error: undefined, detail: undefined, logPath: undefined }));
    case 'progress':
      return patchJob(jobs, action.id, j => (j.status === 'encoding' ? { ...j, progress: action.info } : j));
    case 'finished':
      return patchJob(jobs, action.id, j => {
        const r = action.result;
        if (r.status === 'complete') return { ...j, status: 'complete', output: r.output, progress: { ...(j.progress ?? { timeSec: 0 }), percent: 100, etaSec: undefined }, logPath: r.logPath, error: undefined, detail: undefined };
        if (r.status === 'cancelled') return { ...j, status: 'cancelled', progress: undefined, logPath: r.logPath, error: undefined };
        return { ...j, status: 'failed', progress: undefined, error: r.error, detail: r.detail, logPath: r.logPath };
      });
    case 'reset':
      return patchJob(jobs, action.id, j => {
        if (!canReset(j)) return j;
        return { ...j, status: j.media ? 'ready' : 'pending', progress: undefined, error: undefined, detail: undefined, logPath: undefined, overwrite: false, output: j.outputChosen ? j.output : undefined };
      });
    case 'clearCompleted':
      return jobs.filter(j => j.status !== 'complete');
  }
}
