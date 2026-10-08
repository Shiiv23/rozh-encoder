import { describe, expect, it } from 'vitest';
import { buildFfmpegArgs, buildPreviewArgs, EncodeConfigError, escapeFilterValue, formatCommand } from './ffmpegArgs';
import { parseProbe } from './probe';
import { baseSettings, fakeMedia, stream } from './test-helpers';

const filterOf = (args: string[], flag: '-vf' | '-filter_complex') => args[args.indexOf(flag) + 1];
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const mapsOf = (args: string[]) => args.flatMap((a, i) => (a === '-map' ? [args[i + 1]] : []));

describe('argument safety', () => {
  it('keeps Unicode (Kurdish/Arabic) paths as single, untouched arguments', () => {
    const input = 'C:\\کوردی files\\فیلمی نوێ.mkv';
    const output = 'D:\\دەرچوو\\فیلم_Rozh.mp4';
    const args = buildFfmpegArgs(baseSettings({ input, output }), fakeMedia({ path: input }));
    expect(args).toContain(input);
    expect(args).toContain(output);
    expect(args[args.indexOf('-i') + 1]).toBe(input);
    expect(args[args.length - 1]).toBe(output);
  });

  it('never splits or interprets shell metacharacters in paths', () => {
    const input = '/home/user/My Movie; rm -rf ~ && echo "$(whoami)" `id` \'x\' %PATH% ü.mkv';
    const output = '/home/user/out & more/$(evil).mp4';
    const args = buildFfmpegArgs(baseSettings({ input, output }), fakeMedia());
    expect(args.filter(a => a === input)).toHaveLength(1);
    expect(args[args.length - 1]).toBe(output);
    // Every element is a plain string; nothing has been joined into a command line.
    expect(args.every(a => typeof a === 'string')).toBe(true);
  });

  it('rejects relative paths so a name like "-y" can never be read as an option', () => {
    expect(() => buildFfmpegArgs(baseSettings({ input: 'movie.mkv' }))).toThrow(EncodeConfigError);
    expect(() => buildFfmpegArgs(baseSettings({ output: '-y' }))).toThrow(EncodeConfigError);
  });

  it('refuses to overwrite by default and only uses -y when explicitly requested', () => {
    expect(buildFfmpegArgs(baseSettings())).toContain('-n');
    expect(buildFfmpegArgs(baseSettings())).not.toContain('-y');
    expect(buildFfmpegArgs(baseSettings({ overwrite: true }))).toContain('-y');
  });

  it('requests machine-readable progress on stdout', () => {
    const args = buildFfmpegArgs(baseSettings());
    expect(args).toEqual(expect.arrayContaining(['-hide_banner', '-progress', 'pipe:1', '-nostats']));
  });
});

describe('audio and metadata', () => {
  it('copies source audio, metadata and chapters for Same as Source', () => {
    const args = buildFfmpegArgs(baseSettings({ quality: 'source' }), fakeMedia());
    expect(args).toEqual(expect.arrayContaining(['-c:a', 'copy', '-map_metadata', '0', '-map_chapters', '0']));
    expect(mapsOf(args)).toContain('0:a?');
  });

  it('encodes AAC with a per-track bitrate and doubles it for multichannel tracks', () => {
    const media = fakeMedia({
      audio: [stream({ index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 6 }), stream({ index: 4, codec_type: 'audio', codec_name: 'aac', channels: 2 })]
    });
    const args = buildFfmpegArgs(baseSettings({ audioMode: 'aac', audioBitrateKbps: 160 }), media);
    expect(args).toEqual(expect.arrayContaining(['-c:a', 'aac', '-b:a:0', '320k', '-b:a:1', '160k']));
  });

  it('encodes Opus with libopus', () => {
    const args = buildFfmpegArgs(baseSettings({ container: 'webm', output: 'C:\\Out\\a.webm', videoEncoder: 'libvpx-vp9', audioMode: 'opus' }), fakeMedia());
    expect(args).toEqual(expect.arrayContaining(['-c:a', 'libopus', '-vbr', 'on']));
    expect(args).toContain('-b:a:0');
  });
});

describe('scaling', () => {
  it('scales to an exact even size that preserves aspect ratio', () => {
    const args = buildFfmpegArgs(baseSettings({ shortEdge: 720 }), fakeMedia());
    expect(filterOf(args, '-vf')).toBe('scale=1280:720:flags=lanczos');
  });

  it('handles portrait video by limiting the shorter edge', () => {
    const media = fakeMedia({ displayWidth: 1080, displayHeight: 1920 });
    expect(filterOf(buildFfmpegArgs(baseSettings({ shortEdge: 720 }), media), '-vf')).toBe('scale=720:1280:flags=lanczos');
  });

  it('keeps ultra-wide sources at the right aspect', () => {
    const media = fakeMedia({ displayWidth: 2560, displayHeight: 1080 });
    expect(filterOf(buildFfmpegArgs(baseSettings({ shortEdge: 720 }), media), '-vf')).toBe('scale=1706:720:flags=lanczos');
  });

  it('never upscales', () => {
    const media = fakeMedia({ displayWidth: 640, displayHeight: 360 });
    const args = buildFfmpegArgs(baseSettings({ shortEdge: 720 }), media);
    expect(args).not.toContain('-vf');
  });

  it('respects rotation metadata (a rotated phone video is portrait on screen)', () => {
    const probe = parseProbe({
      format: { duration: '10' },
      streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }]
    }, 'C:\\clip.mp4');
    expect([probe.displayWidth, probe.displayHeight]).toEqual([1080, 1920]);
    expect(filterOf(buildFfmpegArgs(baseSettings({ shortEdge: 720 }), probe), '-vf')).toBe('scale=720:1280:flags=lanczos');
  });

  it('adds an fps filter before scaling', () => {
    const args = buildFfmpegArgs(baseSettings({ shortEdge: 720, fps: 30 }), fakeMedia());
    expect(filterOf(args, '-vf')).toBe('fps=30,scale=1280:720:flags=lanczos');
  });

  it('REGRESSION: scaling must not silently drop soft subtitle tracks', () => {
    const args = buildFfmpegArgs(baseSettings({ container: 'mkv', output: 'C:\\Out\\a.mkv', shortEdge: 720, subtitles: { mode: 'keep', embedded: [2, 3] } }), fakeMedia());
    expect(mapsOf(args)).toEqual(expect.arrayContaining(['0:2', '0:3']));
  });

  it('throws if scaling is requested without knowing the source size', () => {
    expect(() => buildFfmpegArgs(baseSettings({ shortEdge: 720 }))).toThrow(EncodeConfigError);
  });
});

describe('soft subtitles', () => {
  const keep = (container: 'mp4' | 'mkv' | 'webm', extra = {}) =>
    buildFfmpegArgs(
      baseSettings({
        container,
        output: `C:\\Out\\a.${container}`,
        videoEncoder: container === 'webm' ? 'libvpx-vp9' : 'libx264',
        subtitles: { mode: 'keep', embedded: [2, 3] },
        ...extra
      }),
      fakeMedia()
    );

  it('converts to mov_text for MP4, WebVTT for WebM, and copies for MKV', () => {
    expect(keep('mp4')).toEqual(expect.arrayContaining(['-c:s:0', 'mov_text', '-c:s:1', 'mov_text']));
    expect(keep('webm')).toEqual(expect.arrayContaining(['-c:s:0', 'webvtt', '-c:s:1', 'webvtt']));
    expect(keep('mkv')).toEqual(expect.arrayContaining(['-c:s:0', 'copy', '-c:s:1', 'copy']));
  });

  it('maps only the selected tracks', () => {
    const args = buildFfmpegArgs(baseSettings({ subtitles: { mode: 'keep', embedded: [3] } }), fakeMedia());
    expect(mapsOf(args)).toContain('0:3');
    expect(mapsOf(args)).not.toContain('0:2');
  });

  it('adds no subtitle maps at all when subtitles are off', () => {
    const args = buildFfmpegArgs(baseSettings(), fakeMedia());
    expect(mapsOf(args).filter(m => m.startsWith('0:') && m !== '0:a?' && m !== '0:0')).toEqual([]);
    expect(args.join(' ')).not.toContain('-c:s');
  });

  it('adds an external subtitle as a second input with the chosen character set', () => {
    const args = buildFfmpegArgs(
      baseSettings({ subtitles: { mode: 'keep', embedded: [], external: 'C:\\subs\\کوردی.srt' }, subtitleEncoding: 'cp1256' }),
      fakeMedia()
    );
    const firstInput = args.indexOf('-i');
    const secondInput = args.indexOf('-i', firstInput + 1);
    expect(args[secondInput + 1]).toBe('C:\\subs\\کوردی.srt');
    expect(args.slice(secondInput - 2, secondInput)).toEqual(['-sub_charenc', 'CP1256']);
    expect(mapsOf(args)).toContain('1:0');
    expect(args).toEqual(expect.arrayContaining(['-c:s:0', 'mov_text']));
  });

  it('keeps ASS styling in MKV for an external ASS file', () => {
    const args = buildFfmpegArgs(baseSettings({ container: 'mkv', output: 'C:\\Out\\a.mkv', subtitles: { mode: 'keep', embedded: [], external: 'C:\\s\\a.ass' } }), fakeMedia());
    expect(args).toEqual(expect.arrayContaining(['-c:s:0', 'ass']));
  });
});

describe('trim', () => {
  it('seeks the main input and caps the output length for a start+end trim', () => {
    const args = buildFfmpegArgs(baseSettings({ trim: { startSec: 90, endSec: 225 } }), fakeMedia());
    const firstInput = args.indexOf('-i');
    expect(args.slice(firstInput - 2, firstInput)).toEqual(['-ss', '90.000']);
    expect(after(args, '-t')).toBe('135.000');
  });

  it('seeks with no length cap when only a start point is given', () => {
    const args = buildFfmpegArgs(baseSettings({ trim: { startSec: 30 } }), fakeMedia());
    expect(after(args, '-ss')).toBe('30.000');
    expect(args).not.toContain('-t');
  });

  it('caps the length with no seek when only an end point is given', () => {
    const args = buildFfmpegArgs(baseSettings({ trim: { endSec: 60 } }), fakeMedia());
    expect(args).not.toContain('-ss');
    expect(after(args, '-t')).toBe('60.000');
  });

  it('adds no -ss/-t at all when there is no trim', () => {
    const args = buildFfmpegArgs(baseSettings(), fakeMedia());
    expect(args).not.toContain('-ss');
    expect(args).not.toContain('-t');
  });

  it('seeks the external subtitle input by the same start offset, to stay in sync', () => {
    const args = buildFfmpegArgs(
      baseSettings({ trim: { startSec: 90, endSec: 225 }, subtitles: { mode: 'keep', embedded: [], external: 'C:\\s\\a.srt' } }),
      fakeMedia()
    );
    const secondInput = args.indexOf('-i', args.indexOf('-i') + 1);
    expect(args.slice(secondInput - 2, secondInput)).toEqual(['-ss', '90.000']);
  });

  it('drops chapters (which reference the untrimmed timeline) when trimming, but keeps them otherwise', () => {
    const trimmed = buildFfmpegArgs(baseSettings({ trim: { startSec: 10 } }), fakeMedia());
    expect(after(trimmed, '-map_chapters')).toBe('-1');
    const untrimmed = buildFfmpegArgs(baseSettings(), fakeMedia());
    expect(after(untrimmed, '-map_chapters')).toBe('0');
  });
});

describe('subtitle burn-in', () => {
  it('builds a Unicode-safe subtitles filter for an external file and keeps audio', () => {
    const args = buildFfmpegArgs(baseSettings({ subtitles: { mode: 'burn', source: { kind: 'external', file: 'C:\\subtitles\\کوردی.srt' } } }), fakeMedia());
    expect(filterOf(args, '-vf')).toBe("subtitles=filename='C\\:/subtitles/کوردی.srt'");
    expect(mapsOf(args)).toEqual(expect.arrayContaining(['0:0', '0:a?']));
  });

  it('does not also add soft subtitle tracks when burning', () => {
    const args = buildFfmpegArgs(baseSettings({ subtitles: { mode: 'burn', source: { kind: 'external', file: 'C:\\s\\a.srt' } } }), fakeMedia());
    expect(args.join(' ')).not.toContain('-c:s');
    expect(mapsOf(args)).not.toContain('1:0');
  });

  it('uses the subtitle-stream ordinal (not the absolute stream index) for `si`', () => {
    // Absolute streams 2 and 3 are the first and second subtitle tracks.
    const args = buildFfmpegArgs(baseSettings({ subtitles: { mode: 'burn', source: { kind: 'embedded', streamIndex: 3 } } }), fakeMedia());
    expect(filterOf(args, '-vf')).toBe("subtitles=filename='C\\:/Videos/movie.mkv':si=1");
  });

  it('renders text after scaling so glyphs are crisp at output size', () => {
    const args = buildFfmpegArgs(baseSettings({ shortEdge: 720, subtitles: { mode: 'burn', source: { kind: 'embedded', streamIndex: 2 } } }), fakeMedia());
    const filter = filterOf(args, '-vf');
    expect(filter.indexOf('scale=')).toBeLessThan(filter.indexOf('subtitles='));
  });

  it('burns image-based subtitles (PGS) with an overlay graph', () => {
    const media = fakeMedia({
      subtitles: [stream({ index: 4, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' })],
      streams: []
    });
    const args = buildFfmpegArgs(baseSettings({ shortEdge: 720, subtitles: { mode: 'burn', source: { kind: 'embedded', streamIndex: 4 } } }), media);
    expect(filterOf(args, '-filter_complex')).toBe('[0:0][0:4]overlay=format=auto[rozh_ov];[rozh_ov]scale=1280:720:flags=lanczos[rozh_v]');
    expect(mapsOf(args)).toEqual(expect.arrayContaining(['[rozh_v]', '0:a?']));
  });

  it('passes the external subtitle character set to the filter', () => {
    const args = buildFfmpegArgs(baseSettings({ subtitleEncoding: 'cp1256', subtitles: { mode: 'burn', source: { kind: 'external', file: '/subs/a.srt' } } }), fakeMedia());
    expect(filterOf(args, '-vf')).toBe("subtitles=filename='/subs/a.srt':charenc=CP1256");
  });

  it('throws when there is nothing to burn', () => {
    expect(() => buildFfmpegArgs(baseSettings({ subtitles: { mode: 'burn' } }), fakeMedia())).toThrow(EncodeConfigError);
  });

  it('throws for an embedded track that does not exist', () => {
    expect(() => buildFfmpegArgs(baseSettings({ subtitles: { mode: 'burn', source: { kind: 'embedded', streamIndex: 99 } } }), fakeMedia())).toThrow(EncodeConfigError);
  });

  it('REGRESSION: shifts the subtitle clock when the clip is trimmed, so burned cues stay in sync', () => {
    // Input -ss restarts picture timestamps at 0 while the .srt keeps its original times.
    const args = buildFfmpegArgs(
      baseSettings({ trim: { startSec: 90, endSec: 225 }, subtitles: { mode: 'burn', source: { kind: 'external', file: '/subs/a.srt' } } }),
      fakeMedia()
    );
    expect(filterOf(args, '-vf')).toBe("setpts=PTS+90.000/TB,subtitles=filename='/subs/a.srt',setpts=PTS-90.000/TB");
  });

  it('does not shift the clock when there is no trim', () => {
    const args = buildFfmpegArgs(baseSettings({ subtitles: { mode: 'burn', source: { kind: 'external', file: '/subs/a.srt' } } }), fakeMedia());
    expect(filterOf(args, '-vf')).not.toContain('setpts');
  });

  it('only adds a fallback fonts directory for Arabic subtitles — it never forces a font or style', () => {
    // REGRESSION: Rozh used to force FontName=Noto Naskh Arabic onto every plain-text subtitle,
    // overriding whatever font the user chose. The font a subtitle names must always win, so the
    // filter carries no force_style at all; fontsdir is only an extra place to look for glyphs.
    const args = buildFfmpegArgs(
      baseSettings({ subtitles: { mode: 'burn', source: { kind: 'external', file: '/subs/a.srt' } } }),
      fakeMedia(),
      { dir: '/opt/Rozh/resources/fonts' }
    );
    expect(filterOf(args, '-vf')).toBe("subtitles=filename='/subs/a.srt':fontsdir='/opt/Rozh/resources/fonts'");
    expect(filterOf(args, '-vf')).not.toMatch(/force_style|FontName/);
  });

  it('does not touch the filter at all when no fallback directory is given (non-Arabic subtitles)', () => {
    const args = buildFfmpegArgs(baseSettings({ subtitles: { mode: 'burn', source: { kind: 'external', file: '/subs/a.srt' } } }), fakeMedia());
    expect(filterOf(args, '-vf')).toBe("subtitles=filename='/subs/a.srt'");
  });

  it('leaves .ass/.ssa files and embedded ASS tracks without any style or font override', () => {
    for (const file of ['/subs/a.ass', '/subs/a.SSA']) {
      const args = buildFfmpegArgs(
        baseSettings({ subtitles: { mode: 'burn', source: { kind: 'external', file } } }),
        fakeMedia(),
        { dir: '/fonts' }
      );
      expect(filterOf(args, '-vf')).toBe(`subtitles=filename='${file}':fontsdir='/fonts'`);
    }
    const media = fakeMedia({ subtitles: [stream({ index: 4, codec_type: 'subtitle', codec_name: 'ass' })], streams: [] });
    const args = buildFfmpegArgs(
      baseSettings({ subtitles: { mode: 'burn', source: { kind: 'embedded', streamIndex: 4 } } }),
      media,
      { dir: '/fonts' }
    );
    expect(filterOf(args, '-vf')).not.toMatch(/force_style|FontName/);
  });
});

describe('filter value escaping', () => {
  it('escapes drive-letter colons and converts Windows separators', () => {
    expect(escapeFilterValue('C:\\subtitles\\کوردی.srt')).toBe("'C\\:/subtitles/کوردی.srt'");
  });
  it('escapes single quotes with the two-level close/escape/reopen sequence', () => {
    expect(escapeFilterValue("/subs/it's.srt")).toBe("'/subs/it'\\\\\\''s.srt'");
  });
  it('keeps commas, brackets and semicolons harmless inside the quoted value', () => {
    expect(escapeFilterValue('/subs/a,b;[c].srt')).toBe("'/subs/a,b;[c].srt'");
  });
  it('escapes literal backslashes in POSIX paths', () => {
    expect(escapeFilterValue('/subs/a\\b.srt')).toBe("'/subs/a\\\\b.srt'");
  });
});

describe('video encoders', () => {
  const args = (encoder: any, extra = {}) => buildFfmpegArgs(baseSettings({ videoEncoder: encoder, container: 'mkv', output: 'C:\\Out\\a.mkv', ...extra }), fakeMedia());

  it('x264 uses CRF and a named preset', () => {
    expect(args('libx264', { quality: 'balanced' })).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-crf', '23', '-preset', 'medium']));
  });
  it('x265 tags hvc1 in MP4 only', () => {
    expect(buildFfmpegArgs(baseSettings({ videoEncoder: 'libx265' }), fakeMedia())).toEqual(expect.arrayContaining(['-tag:v', 'hvc1']));
    expect(args('libx265')).not.toContain('-tag:v');
  });
  it('SVT-AV1 gets a NUMERIC preset (a name makes it fail)', () => {
    const a = args('libsvtav1', { speed: 'slow' });
    expect(after(a, '-preset')).toBe('5');
  });
  it('libaom and VP9 set -b:v 0 so -crf is true constant quality', () => {
    expect(args('libaom-av1')).toEqual(expect.arrayContaining(['-b:v', '0', '-cpu-used']));
    expect(args('libvpx-vp9')).toEqual(expect.arrayContaining(['-b:v', '0', '-deadline', 'good']));
  });
  it('REGRESSION: "Visually Lossless" never uses CRF 0 (non-playable 4:4:4 profile)', () => {
    for (const enc of ['libx264', 'libx265', 'libsvtav1', 'libaom-av1', 'libvpx-vp9']) {
      expect(Number(after(args(enc, { quality: 'lossless' }), '-crf'))).toBeGreaterThan(0);
    }
  });
  it('honours a custom CRF and clamps it to the encoder range', () => {
    expect(after(args('libx264', { quality: 'custom', customCrf: 19 }), '-crf')).toBe('19');
    expect(after(args('libx264', { quality: 'custom', customCrf: 999 }), '-crf')).toBe('51');
  });
  it('keeps 10-bit only for encoders that handle it, otherwise outputs 8-bit 4:2:0', () => {
    const tenBit = fakeMedia({ video: stream({ index: 0, codec_type: 'video', width: 1920, height: 1080, pix_fmt: 'yuv420p10le' }) });
    const build = (videoEncoder: any) => buildFfmpegArgs(baseSettings({ videoEncoder, container: 'mkv', output: 'C:\\Out\\a.mkv' }), tenBit);
    expect(after(build('libx265'), '-pix_fmt')).toBe('yuv420p10le');
    expect(after(build('libx264'), '-pix_fmt')).toBe('yuv420p');
  });
  it('adds faststart for MP4 only', () => {
    expect(buildFfmpegArgs(baseSettings(), fakeMedia())).toEqual(expect.arrayContaining(['-movflags', '+faststart']));
    expect(args('libx264')).not.toContain('-movflags');
  });
});

describe('formatCommand (display only)', () => {
  it('quotes values with spaces and leaves simple ones bare', () => {
    expect(formatCommand('ffmpeg', ['-i', 'C:\\a b\\c.mkv', '-n'])).toBe('ffmpeg -i "C:\\a b\\c.mkv" -n');
  });
  it('escapes embedded double quotes', () => {
    expect(formatCommand('ffmpeg', ['say "hi"'])).toBe('ffmpeg "say \\"hi\\""');
  });
});

describe('subtitle preview frame', () => {
  const burnFile = { mode: 'burn' as const, source: { kind: 'external' as const, file: '/subs/کوردی.srt' } };
  const out = '/tmp/rozh-preview/frame.png';
  const preview = (over = {}, at = 12.5, font?: { dir: string }) =>
    buildPreviewArgs(baseSettings({ input: '/v/movie.mkv', subtitles: burnFile, ...over }), fakeMedia(), at, out, font);

  it('renders exactly one PNG frame, seeking in the source, without audio or subtitle streams', () => {
    const args = preview();
    expect(after(args, '-ss')).toBe('12.500');
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args).toEqual(expect.arrayContaining(['-an', '-sn', '-frames:v', '1', '-c:v', 'png']));
    expect(args[args.length - 1]).toBe(out);
    expect(args).toContain('-y');
  });

  it('uses the same subtitles filter as a real encode, including Unicode paths and the font directory', () => {
    const args = preview({}, 12.5, { dir: '/res/fonts' });
    const preset = filterOf(args, '-vf');
    expect(preset).toContain("subtitles=filename='/subs/کوردی.srt':fontsdir='/res/fonts'");
    const real = filterOf(buildFfmpegArgs(baseSettings({ input: '/v/movie.mkv', subtitles: burnFile }), fakeMedia(), { dir: '/res/fonts' }), '-vf');
    expect(real).toContain("subtitles=filename='/subs/کوردی.srt':fontsdir='/res/fonts'");
  });

  it('shifts the subtitle clock by the seek position so cue times line up', () => {
    const filter = filterOf(preview({}, 70), '-vf');
    expect(filter).toBe("setpts=PTS+70.000/TB,subtitles=filename='/subs/کوردی.srt',setpts=PTS-70.000/TB");
  });

  it('scales to the output size so wrapping is judged at the real resolution, but ignores frame-rate changes', () => {
    const filter = filterOf(preview({ shortEdge: 480, fps: 24 }, 5), '-vf');
    expect(filter).toContain('scale=854:480:flags=lanczos');
    expect(filter).not.toContain('fps=');
    expect(filter.indexOf('scale=')).toBeLessThan(filter.indexOf('subtitles='));
  });

  it('leaves out the watermark, codecs and chapter/metadata handling', () => {
    const args = preview({ watermark: { enabled: true, file: '/logo.png', position: 'top-right', sizePct: 10, marginPct: 3, opacityPct: 80 }, quality: 'high' });
    expect(args).not.toContain('-filter_complex');
    expect(args).not.toContain('/logo.png');
    expect(args).not.toContain('-crf');
    expect(args).not.toContain('-map_chapters');
    expect(args).not.toContain('-progress');
  });

  it('overlays bitmap subtitle tracks and maps the result', () => {
    const media = fakeMedia({ subtitles: [stream({ index: 2, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' })] });
    const args = buildPreviewArgs(baseSettings({ input: '/v/movie.mkv', subtitles: { mode: 'burn', source: { kind: 'embedded', streamIndex: 2 } } }), media, 3, out);
    expect(filterOf(args, '-filter_complex')).toBe('[0:0][0:2]overlay=format=auto[rozh_v]');
    expect(mapsOf(args)).toEqual(['[rozh_v]']);
  });

  it('refuses things that are not a burn-in preview', () => {
    expect(() => buildPreviewArgs(baseSettings({ input: '/v/m.mkv' }), fakeMedia(), 1, out)).toThrow(EncodeConfigError);
    expect(() => buildPreviewArgs(baseSettings({ input: 'relative.mkv', subtitles: burnFile }), fakeMedia(), 1, out)).toThrow(EncodeConfigError);
    expect(() => buildPreviewArgs(baseSettings({ input: '/v/m.mkv', subtitles: burnFile }), fakeMedia(), 1, 'frame.png')).toThrow(EncodeConfigError);
    expect(() => buildPreviewArgs(baseSettings({ input: '/v/m.mkv', subtitles: burnFile }), fakeMedia(), 1, '/tmp/frame.mp4')).toThrow(EncodeConfigError);
    expect(() => buildPreviewArgs(baseSettings({ input: '/v/m.mkv', subtitles: burnFile }), fakeMedia(), -1, out)).toThrow(EncodeConfigError);
    expect(() => buildPreviewArgs(baseSettings({ input: '/v/m.mkv', subtitles: { mode: 'burn' } }), fakeMedia(), 1, out)).toThrow(EncodeConfigError);
  });
});
