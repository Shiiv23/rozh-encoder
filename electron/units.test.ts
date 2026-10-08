import { describe, expect, it } from 'vitest';
import { basename, dirname, extname, partialPath, pathKey, samePath, stem, uniqueOutputPath } from './paths';
import { ProgressParser, summarizeFfmpegError } from './progress';
import { parseProbe } from './probe';
import { computeScaleTarget, formatBytes, formatDuration, parseFrameRate } from './rules';

describe('paths (Windows and POSIX, Unicode)', () => {
  it('handles Windows paths regardless of host OS', () => {
    const p = 'D:\\فیلم کوردی\\سڵاو.mkv';
    expect(basename(p)).toBe('سڵاو.mkv');
    expect(dirname(p)).toBe('D:\\فیلم کوردی');
    expect(extname(p)).toBe('.mkv');
    expect(stem(p)).toBe('سڵاو');
  });
  it('compares Windows paths case-insensitively but POSIX paths exactly', () => {
    expect(samePath('C:\\Videos\\A.mkv', 'c:/videos/a.MKV')).toBe(true);
    expect(samePath('/v/A.mkv', '/v/a.mkv')).toBe(false);
    expect(pathKey('C:\\a\\..\\b\\c.mkv')).toBe(pathKey('c:\\b\\c.mkv'));
  });
  it('picks unique output names and never the source', () => {
    const taken = new Set(['C:\\Out\\movie_Rozh.mp4']);
    expect(uniqueOutputPath('C:\\Out', 'movie.mkv', 'mp4', c => taken.has(c))).toBe('C:\\Out\\movie_Rozh (2).mp4');
  });
  it('places the partial file next to the output with the real extension last', () => {
    expect(partialPath('C:\\Out\\a.mp4')).toBe('C:\\Out\\a.rozh-partial.mp4');
  });
});

describe('progress parsing', () => {
  it('handles chunk boundaries, microsecond timestamps, speed and ETA', () => {
    const seen: any[] = [];
    const parser = new ProgressParser(100, i => seen.push(i));
    const text = 'fps=30.0\ntotal_size=1000\nout_time_us=25000000\nspeed=2.5x\nprogress=continue\n';
    parser.push(text.slice(0, 17));
    parser.push(text.slice(17));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ percent: 25, timeSec: 25, speed: 2.5, sizeBytes: 1000 });
    expect(seen[0].etaSec).toBeCloseTo(30);
  });
  it('reports no percentage when the duration is unknown, and 100 at the end', () => {
    const seen: any[] = [];
    const parser = new ProgressParser(undefined, i => seen.push(i));
    parser.push('out_time_us=1000000\nprogress=continue\nout_time_us=2000000\nprogress=end\n');
    expect(seen[0].percent).toBeUndefined();
    expect(seen[1].percent).toBe(100);
  });
  it('ignores N/A timestamps', () => {
    const seen: any[] = [];
    new ProgressParser(10, i => seen.push(i)).push('out_time_us=N/A\nout_time=N/A\nprogress=continue\n');
    expect(seen[0].timeSec).toBe(0);
  });
});

describe('error summaries', () => {
  it('recognises common failures and keeps the tail for details', () => {
    const r = summarizeFfmpegError('frame=1\nUnknown encoder \'libx265\'\n', 1);
    expect(r.summary).toContain('libx265');
    expect(summarizeFfmpegError('Something odd happened\n', 1).summary).toContain('Something odd');
  });
});

describe('ffprobe parsing', () => {
  const probe = (streams: any[], format: any = { duration: '12.5', size: '100', bit_rate: '800000', format_name: 'matroska,webm' }) => parseProbe({ format, streams, chapters: [{}, {}] }, 'C:\\a.mkv', 100);
  it('ignores cover art when choosing the video stream', () => {
    const m = probe([
      { index: 0, codec_type: 'video', codec_name: 'mjpeg', width: 300, height: 300, disposition: { attached_pic: 1 } },
      { index: 1, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }
    ]);
    expect(m.video?.index).toBe(1);
    expect(m.chapters).toBe(2);
  });
  it('detects HDR and falls back to stream duration', () => {
    const m = probe([{ index: 0, codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, color_transfer: 'smpte2084', duration: '9' }], {});
    expect(m.isHdr).toBe(true);
    expect(m.duration).toBe(9);
  });
  it('supports the legacy rotate tag', () => {
    const m = probe([{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, tags: { rotate: '90' } }]);
    expect([m.displayWidth, m.displayHeight]).toEqual([1080, 1920]);
  });
});

describe('formatting and geometry', () => {
  it('formats sizes and durations', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(undefined)).toBe('—');
  });
  it('parses frame rates including NTSC fractions and 0/0', () => {
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('0/0')).toBeUndefined();
  });
  it('scales down only, to even dimensions', () => {
    expect(computeScaleTarget(1920, 1080, 720)).toEqual({ width: 1280, height: 720 });
    expect(computeScaleTarget(1280, 720, 1080)).toBeUndefined();
  });
});
