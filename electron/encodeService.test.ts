import { describe, expect, it, vi } from 'vitest';
import { EncodeService, type EncodeServiceDeps } from './encodeService';
import { baseSettings, fakeMedia } from './test-helpers';
import type { FfmpegStatus } from './types';

const okStatus: FfmpegStatus = {
  available: true, encoders: ['libx264', 'libx265'], hardware: [],
  ffmpeg: { found: true, version: 'ffmpeg 7', path: 'ffmpeg' }, ffprobe: { found: true, version: 'ffprobe 7', path: 'ffprobe' }
};

function deps(over: Partial<EncodeServiceDeps> = {}) {
  let release!: (v: any) => void;
  const done = new Promise<any>(r => { release = r; });
  const cancel = vi.fn(() => release({ status: 'cancelled', log: 'LOG', command: 'cmd' }));
  const base: EncodeServiceDeps = {
    detect: async () => okStatus,
    inspect: async () => fakeMedia(),
    startEncoding: vi.fn(() => ({ args: [], command: 'cmd', cancel, done })),
    writeLog: async () => 'C:\\logs\\a.log'
  };
  return { deps: { ...base, ...over }, release, cancel };
}

describe('EncodeService', () => {
  it('refuses to start when FFmpeg is unavailable, with the reason', async () => {
    const { deps: d } = deps({ detect: async () => ({ ...okStatus, available: false, problem: 'FFmpeg was not found.' }) });
    const result = await new EncodeService(d).start('a', baseSettings(), () => {});
    expect(result).toEqual({ status: 'failed', error: 'FFmpeg was not found.' });
    expect(d.startEncoding).not.toHaveBeenCalled();
  });

  it('re-validates in the main process and blocks invalid combinations (H.264 into WebM)', async () => {
    const { deps: d } = deps();
    const result = await new EncodeService(d).start('a', baseSettings({ container: 'webm', output: 'C:\\Out\\a.webm' }), () => {});
    expect(result.status).toBe('failed');
    expect(d.startEncoding).not.toHaveBeenCalled();
  });

  it('runs one encode at a time', async () => {
    const { deps: d, release } = deps();
    const service = new EncodeService(d);
    const first = service.start('a', baseSettings(), () => {});
    await new Promise(r => setTimeout(r, 5));
    expect(service.busy).toBe(true);
    const second = await service.start('b', baseSettings(), () => {});
    expect(second.status).toBe('failed');
    release({ status: 'complete', output: 'C:\\Out\\a.mp4', log: 'L', command: 'c' });
    expect((await first).status).toBe('complete');
    expect(service.busy).toBe(false);
  });

  it('cancels only the job that is running and returns the log path', async () => {
    const { deps: d, cancel } = deps();
    const service = new EncodeService(d);
    const run = service.start('a', baseSettings(), () => {});
    await new Promise(r => setTimeout(r, 5));
    expect(service.cancel('other')).toBe(false);
    expect(service.cancel('a')).toBe(true);
    expect(cancel).toHaveBeenCalled();
    expect(await run).toEqual({ status: 'cancelled', logPath: 'C:\\logs\\a.log' });
  });

  it('is free again after a failure to inspect the file', async () => {
    const { deps: d } = deps({ inspect: async () => { throw new Error('The selected file no longer exists or cannot be read.'); } });
    const service = new EncodeService(d);
    expect((await service.start('a', baseSettings(), () => {})).status).toBe('failed');
    expect(service.busy).toBe(false);
  });
});
