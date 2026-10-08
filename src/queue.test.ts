import { describe, expect, it, vi } from 'vitest';
import { fakeMedia } from '../electron/test-helpers';
import { canMove, counts, queueReducer, type Action, type Job } from './queue';
import { QueueRunner } from './queueRunner';
import type { EncodeResult } from '../electron/types';

const apply = (jobs: Job[], ...actions: Action[]) => actions.reduce(queueReducer, jobs);
const seed = (n: number): Job[] => apply([], { type: 'add', items: Array.from({ length: n }, (_, i) => ({ id: `j${i + 1}`, input: `C:\\v\\فیلم ${i + 1}.mkv` })) });
const ready = (jobs: Job[]) => jobs.reduce((acc, j) => apply(acc, { type: 'analyzing', id: j.id }, { type: 'analyzed', id: j.id, media: fakeMedia() }), jobs);

describe('queue reducer', () => {
  it('adds jobs as pending and moves them through analysing to ready', () => {
    let jobs = seed(1);
    expect(jobs[0]).toMatchObject({ status: 'pending', name: 'فیلم 1.mkv', overwrite: false, outputChosen: false });
    jobs = apply(jobs, { type: 'analyzing', id: 'j1' });
    expect(jobs[0].status).toBe('analyzing');
    jobs = apply(jobs, { type: 'analyzed', id: 'j1', media: fakeMedia() });
    expect(jobs[0].status).toBe('ready');
  });

  it('marks unreadable files as failed with the reason', () => {
    const jobs = apply(seed(1), { type: 'analyzing', id: 'j1' }, { type: 'analysisFailed', id: 'j1', error: 'not a video' });
    expect(jobs[0]).toMatchObject({ status: 'failed', error: 'not a video' });
  });

  it('reorders and respects the ends of the list', () => {
    let jobs = seed(3);
    jobs = apply(jobs, { type: 'move', id: 'j3', delta: -1 });
    expect(jobs.map(j => j.id)).toEqual(['j1', 'j3', 'j2']);
    expect(canMove(jobs, 'j1', -1)).toBe(false);
    expect(canMove(jobs, 'j2', 1)).toBe(false);
    expect(apply(jobs, { type: 'move', id: 'j1', delta: -1 }).map(j => j.id)).toEqual(['j1', 'j3', 'j2']);
  });

  it('cannot remove a job that is encoding, but can remove others', () => {
    let jobs = ready(seed(2));
    jobs = apply(jobs, { type: 'encoding', id: 'j1' });
    expect(apply(jobs, { type: 'remove', id: 'j1' })).toHaveLength(2);
    expect(apply(jobs, { type: 'remove', id: 'j2' }).map(j => j.id)).toEqual(['j1']);
  });

  it('records progress only while encoding', () => {
    let jobs = ready(seed(1));
    expect(apply(jobs, { type: 'progress', id: 'j1', info: { timeSec: 3, percent: 30 } })[0].progress).toBeUndefined();
    jobs = apply(jobs, { type: 'encoding', id: 'j1' }, { type: 'progress', id: 'j1', info: { timeSec: 3, percent: 30 } });
    expect(jobs[0].progress?.percent).toBe(30);
  });

  it('stores each outcome: complete, failed (with detail and log) and cancelled', () => {
    const base = ready(seed(3)).map(j => queueReducer([j], { type: 'encoding', id: j.id })[0]);
    const done = apply(base,
      { type: 'finished', id: 'j1', result: { status: 'complete', output: 'C:\\o\\1.mp4', logPath: 'L1' } },
      { type: 'finished', id: 'j2', result: { status: 'failed', error: 'boom', detail: 'tail', logPath: 'L2' } },
      { type: 'finished', id: 'j3', result: { status: 'cancelled' } });
    expect(done.map(j => j.status)).toEqual(['complete', 'failed', 'cancelled']);
    expect(done[0]).toMatchObject({ output: 'C:\\o\\1.mp4', logPath: 'L1' });
    expect(done[1]).toMatchObject({ error: 'boom', detail: 'tail' });
    expect(counts(done)).toMatchObject({ complete: 1, failed: 1, cancelled: 1 });
  });

  it('reset returns finished jobs to ready and revokes any overwrite permission', () => {
    let jobs = ready(seed(1));
    jobs = apply(jobs, { type: 'setOutput', id: 'j1', output: 'C:\\o\\x.mp4', chosen: true, overwrite: true }, { type: 'encoding', id: 'j1' }, { type: 'finished', id: 'j1', result: { status: 'cancelled' } }, { type: 'reset', id: 'j1' });
    expect(jobs[0]).toMatchObject({ status: 'ready', overwrite: false, output: 'C:\\o\\x.mp4' });
  });

  it('automatic outputs never overwrite a chosen output or a completed job', () => {
    let jobs = ready(seed(2));
    jobs = apply(jobs, { type: 'setOutput', id: 'j1', output: 'C:\\mine.mp4', chosen: true, overwrite: false });
    jobs = apply(jobs, { type: 'setPlanned', outputs: { j1: 'C:\\auto1.mp4', j2: 'C:\\auto2.mp4' } });
    expect(jobs.map(j => j.output)).toEqual(['C:\\mine.mp4', 'C:\\auto2.mp4']);
  });

  it('clears completed jobs only', () => {
    let jobs = ready(seed(2));
    jobs = apply(jobs, { type: 'encoding', id: 'j1' }, { type: 'finished', id: 'j1', result: { status: 'complete', output: 'C:\\o.mp4' } }, { type: 'clearCompleted' });
    expect(jobs.map(j => j.id)).toEqual(['j2']);
  });

  it('locks per-file choices while encoding', () => {
    let jobs = apply(ready(seed(1)), { type: 'encoding', id: 'j1' }, { type: 'setSubtitle', id: 'j1', patch: { externalSubtitle: 'C:\\s.srt' } });
    expect(jobs[0].externalSubtitle).toBeUndefined();
  });

  it('sets and clears trim points independently, and locks them while encoding', () => {
    let jobs = apply(ready(seed(1)), { type: 'setTrim', id: 'j1', patch: { startSec: 90, endSec: 225 } });
    expect(jobs[0]).toMatchObject({ trimStartSec: 90, trimEndSec: 225 });
    jobs = apply(jobs, { type: 'setTrim', id: 'j1', patch: { startSec: null } });
    expect(jobs[0]).toMatchObject({ trimStartSec: undefined, trimEndSec: 225 });
    jobs = apply(jobs, { type: 'encoding', id: 'j1' }, { type: 'setTrim', id: 'j1', patch: { endSec: 10 } });
    expect(jobs[0].trimEndSec).toBe(225);
  });
});

describe('QueueRunner', () => {
  const build = (jobs: Job[], run: (job: Job, signal: { cancelled: boolean }) => Promise<EncodeResult>) => {
    let state = jobs;
    const log: string[] = [];
    const cancelled = new Set<string>();
    const runner: QueueRunner = new QueueRunner({
      getJobs: () => state,
      runJob: job => run(job, { get cancelled() { return cancelled.has(job.id); } } as { cancelled: boolean }),
      cancelJob: id => { cancelled.add(id); log.push(`cancel ${id}`); },
      onStart: id => { log.push(`start ${id}`); state = queueReducer(state, { type: 'encoding', id }); },
      onResult: (id, result) => { log.push(`${result.status} ${id}`); state = queueReducer(state, { type: 'finished', id, result }); }
    });
    return { runner, log, get state() { return state; } };
  };
  const ok = (id: string): EncodeResult => ({ status: 'complete', output: `C:\\o\\${id}.mp4` });

  it('runs jobs one after another in queue order', async () => {
    let active = 0; let maxActive = 0;
    const h = build(ready(seed(3)), async job => { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 2)); active--; return ok(job.id); });
    await h.runner.run({ kind: 'queue' });
    expect(maxActive).toBe(1);
    expect(h.log).toEqual(['start j1', 'complete j1', 'start j2', 'complete j2', 'start j3', 'complete j3']);
  });

  it('a failing job does not stop the rest of the queue', async () => {
    const h = build(ready(seed(3)), async job => (job.id === 'j2' ? { status: 'failed', error: 'x' } : ok(job.id)));
    await h.runner.run({ kind: 'queue' });
    expect(h.state.map(j => j.status)).toEqual(['complete', 'failed', 'complete']);
  });

  it('Stop cancels the current job and prevents every remaining job from starting', async () => {
    const h = build(ready(seed(3)), (job, signal) => new Promise<EncodeResult>(resolve => {
      const timer = setInterval(() => { if (signal.cancelled) { clearInterval(timer); resolve({ status: 'cancelled' }); } }, 1);
    }));
    const finished = h.runner.run({ kind: 'queue' });
    await new Promise(r => setTimeout(r, 10));
    expect(h.runner.running).toBe(true);
    h.runner.stop();
    await finished;
    expect(h.log).toEqual(['start j1', 'cancel j1', 'cancelled j1']);
    expect(h.state.map(j => j.status)).toEqual(['cancelled', 'ready', 'ready']);
    expect(h.runner.running).toBe(false);
  });

  it('single mode runs only the chosen job', async () => {
    const h = build(ready(seed(3)), async job => ok(job.id));
    await h.runner.run({ kind: 'single', id: 'j2' });
    expect(h.state.map(j => j.status)).toEqual(['ready', 'complete', 'ready']);
  });

  it('skips jobs that are not ready (failed analysis, pending)', async () => {
    const jobs = apply(seed(3), { type: 'analyzing', id: 'j1' }, { type: 'analysisFailed', id: 'j1', error: 'bad' }, { type: 'analyzing', id: 'j2' }, { type: 'analyzed', id: 'j2', media: fakeMedia() });
    const h = build(jobs, async job => ok(job.id));
    await h.runner.run({ kind: 'queue' });
    expect(h.log).toEqual(['start j2', 'complete j2']);
  });

  it('turns a thrown error into a failed job and keeps going', async () => {
    const h = build(ready(seed(2)), async job => { if (job.id === 'j1') throw new Error('kaboom'); return ok(job.id); });
    await h.runner.run({ kind: 'queue' });
    expect(h.state.map(j => j.status)).toEqual(['failed', 'complete']);
    expect(h.state[0].error).toBe('kaboom');
  });

  it('picks up jobs added while running and honours reordering', async () => {
    const h = build(ready(seed(2)), async job => ok(job.id));
    const done = h.runner.run({ kind: 'queue' });
    await done;
    expect(h.log.filter(l => l.startsWith('start'))).toHaveLength(2);
  });

  it('ignores a second run while one is active and Stop when idle', async () => {
    const spy = vi.fn(async (job: Job) => ok(job.id));
    const h = build(ready(seed(1)), spy);
    h.runner.stop();
    const a = h.runner.run({ kind: 'queue' });
    const b = h.runner.run({ kind: 'queue' });
    await Promise.all([a, b]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
