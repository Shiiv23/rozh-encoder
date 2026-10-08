import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { escapeFilterValue } from './ffmpegArgs';

type Behaviour = (child: FakeChild, args: string[]) => void;
let behaviour: Behaviour = () => {};
let spawned: Array<{ command: string; args: string[]; options: unknown }> = [];

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed: string[] = [];
  kill(signal?: string) { this.killed.push(signal ?? 'SIGTERM'); return true; }
  finish(code: number | null, signal: string | null = null) { setTimeout(() => this.emit('close', code, signal), 5); }
}

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: unknown) => {
    spawned.push({ command, args, options });
    const child = new FakeChild();
    setTimeout(() => behaviour(child, args), 0);
    return child;
  }
}));

import { LogBuffer, parseEncoderList, startEncoding, detectFfmpeg, setFallbackFontsDir } from './media';
import { baseSettings, fakeMedia } from './test-helpers';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozh-')); spawned = []; });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

const settingsIn = (over = {}) => baseSettings({ input: path.join(dir, 'in.mkv'), output: path.join(dir, 'out.mp4'), ...over });
const partialOf = () => path.join(dir, 'out.rozh-partial.mp4');

describe('startEncoding', () => {
  it('writes to a temporary file and only moves it into place after FFmpeg succeeds', async () => {
    behaviour = (child, args) => { fs.writeFileSync(args[args.length - 1], 'video'); child.stdout.write('out_time_us=5000000\nprogress=continue\n'); child.finish(0); };
    const progress = vi.fn();
    const job = startEncoding(settingsIn(), fakeMedia({ duration: 10 }), progress);
    // Every FFmpeg argument that names the output points at the partial file, never the final one.
    expect(job.args[job.args.length - 1]).toBe(partialOf());
    expect(job.args).not.toContain(path.join(dir, 'out.mp4'));
    const result = await job.done;
    expect(result.status).toBe('complete');
    expect(fs.existsSync(path.join(dir, 'out.mp4'))).toBe(true);
    expect(fs.existsSync(partialOf())).toBe(false);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ percent: 50 }));
  });

  it('spawns an argument array without a shell', async () => {
    behaviour = (child, args) => { fs.writeFileSync(args[args.length - 1], 'x'); child.finish(0); };
    await startEncoding(settingsIn(), fakeMedia(), () => {}).done;
    const call = spawned[0];
    expect(Array.isArray(call.args)).toBe(true);
    expect((call.options as { shell?: boolean }).shell).toBeUndefined();
  });

  it('cancel asks FFmpeg to quit, removes the partial file and reports cancelled', async () => {
    behaviour = (child, args) => {
      fs.writeFileSync(args[args.length - 1], 'half');
      child.stdin.on('data', d => { if (String(d).startsWith('q')) child.finish(0); });
    };
    const job = startEncoding(settingsIn(), fakeMedia(), () => {});
    await new Promise(r => setTimeout(r, 30));
    expect(fs.existsSync(partialOf())).toBe(true);
    job.cancel();
    const result = await job.done;
    expect(result.status).toBe('cancelled');
    expect(fs.existsSync(partialOf())).toBe(false);
    expect(fs.existsSync(path.join(dir, 'out.mp4'))).toBe(false);
  });

  it('escalates to SIGTERM then SIGKILL when FFmpeg ignores the quit request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let fake!: FakeChild;
    behaviour = child => { fake = child; };
    const job = startEncoding(settingsIn(), fakeMedia(), () => {});
    await vi.advanceTimersByTimeAsync(1);
    job.cancel();
    await vi.advanceTimersByTimeAsync(4_100);
    expect(fake.killed).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(4_100);
    expect(fake.killed).toEqual(['SIGTERM', 'SIGKILL']);
    fake.finish(null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(10);
    expect((await job.done).status).toBe('cancelled');
  });

  it('a failed encode leaves nothing behind and explains why', async () => {
    behaviour = (child, args) => {
      fs.writeFileSync(args[args.length - 1], 'junk');
      child.stderr.write('Error opening output file: No space left on device\n');
      child.finish(1);
    };
    const result = await startEncoding(settingsIn(), fakeMedia(), () => {}).done;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.toLowerCase()).toMatch(/full/);
    expect(fs.existsSync(partialOf())).toBe(false);
    expect(fs.existsSync(path.join(dir, 'out.mp4'))).toBe(false);
  });

  it('never replaces an existing output unless overwrite was confirmed, and never even starts FFmpeg', async () => {
    fs.writeFileSync(path.join(dir, 'out.mp4'), 'precious');
    behaviour = (child, args) => { fs.writeFileSync(args[args.length - 1], 'new'); child.finish(0); };
    const result = await startEncoding(settingsIn(), fakeMedia(), () => {}).done;
    expect(result.status).toBe('failed');
    expect(spawned).toHaveLength(0);
    expect(fs.readFileSync(path.join(dir, 'out.mp4'), 'utf8')).toBe('precious');
  });

  it('replaces the output only when overwrite is true', async () => {
    fs.writeFileSync(path.join(dir, 'out.mp4'), 'old');
    behaviour = (child, args) => { fs.writeFileSync(args[args.length - 1], 'new'); child.finish(0); };
    const result = await startEncoding(settingsIn({ overwrite: true }), fakeMedia(), () => {}).done;
    expect(result.status).toBe('complete');
    expect(fs.readFileSync(path.join(dir, 'out.mp4'), 'utf8')).toBe('new');
  });

  it('does not touch the source file', async () => {
    fs.writeFileSync(path.join(dir, 'in.mkv'), 'source-bytes');
    behaviour = (child, args) => { fs.writeFileSync(args[args.length - 1], 'x'); child.finish(0); };
    await startEncoding(settingsIn(), fakeMedia(), () => {}).done;
    expect(fs.readFileSync(path.join(dir, 'in.mkv'), 'utf8')).toBe('source-bytes');
  });

  it('reports success-without-output as a failure', async () => {
    behaviour = child => child.finish(0);
    expect((await startEncoding(settingsIn(), fakeMedia(), () => {}).done).status).toBe('failed');
  });

  it('turns an unbuildable configuration into a failed result instead of throwing', async () => {
    const job = startEncoding(settingsIn({ shortEdge: 720 }), fakeMedia({ displayWidth: undefined, displayHeight: undefined, video: undefined }), () => {});
    expect((await job.done).status).toBe('failed');
    expect(spawned).toHaveLength(0);
  });

  it('reports a missing FFmpeg executable clearly', async () => {
    behaviour = child => child.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }));
    const result = await startEncoding(settingsIn(), fakeMedia(), () => {}).done;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toMatch(/not found/i);
  });

  it('cancelling before FFmpeg has reported anything still ends in cancelled', async () => {
    behaviour = () => {};
    const job = startEncoding(settingsIn(), fakeMedia(), () => {});
    job.cancel();
    job.cancel(); // idempotent
  });
});

describe('Arabic-script subtitle burn-in', () => {
  afterEach(() => setFallbackFontsDir(undefined));

  const arabicSrt = () => {
    const file = path.join(dir, 'کوردی.srt');
    fs.writeFileSync(file, '1\n00:00:00,000 --> 00:00:02,000\nسڵاو، ئەمە تاقیکردنەوەیەکە\n\n', 'utf8');
    return file;
  };

  it('repairs the text and offers the fallback fonts, but never forces a font or style', () => {
    const fontsDir = path.join(process.cwd(), 'resources', 'fonts');
    setFallbackFontsDir(fontsDir);
    const settings = settingsIn({ subtitles: { mode: 'burn', source: { kind: 'external', file: arabicSrt() } } });
    const job = startEncoding(settings, fakeMedia(), () => {});
    const subtitleFilter = job.args[job.args.indexOf('-vf') + 1];
    expect(subtitleFilter).toContain(`fontsdir=${escapeFilterValue(fontsDir)}`);
    expect(subtitleFilter).not.toMatch(/force_style|FontName/);
    // The burned file is a repaired UTF-8 copy, not the user's original.
    expect(subtitleFilter).not.toContain(path.join(dir, 'کوردی.srt'));
    job.cancel();
  });

  it('leaves a non-Arabic subtitle file completely alone even when fallback fonts are set', () => {
    setFallbackFontsDir('/opt/Rozh/resources/fonts');
    const file = path.join(dir, 'en.srt');
    fs.writeFileSync(file, '1\n00:00:00,000 --> 00:00:02,000\nHello there\n\n', 'utf8');
    const settings = settingsIn({ subtitles: { mode: 'burn', source: { kind: 'external', file } } });
    const job = startEncoding(settings, fakeMedia(), () => {});
    const subtitleFilter = job.args[job.args.indexOf('-vf') + 1];
    expect(subtitleFilter).not.toContain('fontsdir=');
    expect(subtitleFilter).not.toContain('force_style=');
    expect(subtitleFilter).toContain(`filename=${escapeFilterValue(file)}`);
    job.cancel();
  });

  it('still repairs Arabic text when no fallback fonts are bundled', () => {
    const settings = settingsIn({ subtitles: { mode: 'burn', source: { kind: 'external', file: arabicSrt() } } });
    const job = startEncoding(settings, fakeMedia(), () => {});
    expect(job.command).not.toContain('fontsdir=');
    job.cancel();
  });

  it('reads a Windows-1256 file correctly and does not run iconv on the already-converted copy', () => {
    const file = path.join(dir, 'legacy.srt');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('1\n00:00:00,000 --> 00:00:02,000\n'), Buffer.from([0xe3, 0xd1, 0xcd, 0xc8, 0xc7]), Buffer.from('\n\n')]));
    const job = startEncoding(settingsIn({ subtitleEncoding: 'cp1256', subtitles: { mode: 'burn', source: { kind: 'external', file } } }), fakeMedia(), () => {});
    expect(job.command).not.toContain('charenc=');
    expect(job.command).not.toContain(file);
    job.cancel();
  });
});

describe('detectFfmpeg', () => {
  it('reports unavailable, with a reason, when neither binary can be started', async () => {
    behaviour = child => child.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }));
    const status = await detectFfmpeg();
    expect(status.available).toBe(false);
    expect(status.problem).toMatch(/not found/i);
  });

  it('is available only when ffmpeg, ffprobe and at least one encoder are present', async () => {
    behaviour = (child, args) => {
      if (args.includes('-encoders')) child.stdout.write(' V....D libx264              libx264 H.264\n V....D h264_nvenc           NVENC\n');
      else child.stdout.write('ffmpeg version 7.0 Copyright\n');
      child.finish(0);
    };
    const status = await detectFfmpeg();
    expect(status.available).toBe(true);
    expect(status.encoders).toContain('libx264');
    expect(status.hardware).toEqual(['h264_nvenc']);
  });
});

describe('helpers', () => {
  it('parses the encoder table and skips the legend', () => {
    const text = ' ------\n V....D libx264              libx264 H.264\n A....D aac                  AAC\n';
    expect(parseEncoderList(text)).toEqual(['libx264', 'aac']);
  });

  it('LogBuffer keeps the start and the recent end of a huge log', () => {
    const log = new LogBuffer(10, 20);
    log.append('HEAD-------');
    for (let i = 0; i < 50; i++) log.append(`line${i}\n`);
    const text = log.toString();
    expect(text.startsWith('HEAD-----')).toBe(true);
    expect(text).toContain('truncated');
    expect(text).toContain('line49');
    expect(text).not.toContain('line3\n');
  });
});
