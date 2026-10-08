// Runs REAL FFmpeg/FFprobe when they are installed and is skipped (visibly) when they are not.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { detectFfmpeg, inspectMedia, renderSubtitlePreview, setFallbackFontsDir, startEncoding } from './media';
import { baseSettings } from './test-helpers';
import { pngSize } from './subtitlePreview';
import type { FfmpegStatus, MediaInfo } from './types';

const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' });
const hasTools = run('ffmpeg', ['-version']).status === 0 && run('ffprobe', ['-version']).status === 0;
const soraniText = 'سڵاو چۆنی گەواد ڤیەگل؟\nباشم، سوپاس بۆ پرسیارەکەت.\nئەمڕۆ ڕۆژێکی جوانە؛ ڕ، ڵ، ۆ، ێ، ە، ڤ، گ، چ، پ، ژ.\n2026 ساڵی نوێی کوردی پیرۆز بێت!';

const soraniAss = (scriptType: 'v4.00+' | 'v4.00', font = 'Adobe Arabic'): string => {
  const styles = scriptType === 'v4.00+' ? '[V4+ Styles]' : '[V4 Styles]';
  const styleFormat = scriptType === 'v4.00+'
    ? `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font},30,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,1,2,0,2,20,20,20,1`
    : `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding\nStyle: Default,${font},30,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,1,2,0,2,20,20,20,0,1`;
  const section = scriptType === 'v4.00+' ? 'ScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360' : 'ScriptType: v4.00\nPlayResX: 640\nPlayResY: 360';
  const dialogue = soraniText.replace(/\n/g, '\\N').replace('سڵاو', '\uFEB3ڵاو');
  return `[Script Info]\n${section}\n\n${styles}\n${styleFormat}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, Effect, Text\nDialogue: 0,0:00:00.00,0:00:03.00,Default,,0,0,0,,${dialogue}\n`;
};

const soraniSubtitleCases = [
  { ext: 'srt', content: `1\n00:00:00,000 --> 00:00:03,000\n${soraniText}\n` },
  { ext: 'ass', content: soraniAss('v4.00+') },
  { ext: 'ssa', content: soraniAss('v4.00') },
  { ext: 'vtt', content: `WEBVTT\n\n00:00:00.000 --> 00:00:03.000\n${soraniText}\n` },
  { ext: 'smi', content: `<SAMI><BODY><SYNC Start="0"><P Class="KRCC">${soraniText.replace(/\n/g, '<br>')}</P></SYNC><SYNC Start="3000"><P Class="KRCC">&nbsp;</P></SYNC></BODY></SAMI>` },
  { ext: 'sub', content: `0:00:00.000,0:00:03.000\n${soraniText.replace(/\n/g, '|')}\n` },
  { ext: 'microdvd.sub', content: `{0}{75}${soraniText.replace(/\n/g, '|')}\n` },
  { ext: 'mpl2', content: `[0][30]${soraniText.replace(/\n/g, '|')}\n` },
  { ext: 'sbv', content: `0:00:00.000,0:00:03.000\n${soraniText}\n` },
  { ext: 'ttml', content: `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="3s">${soraniText.replace(/\n/g, '<br/>')}</p></div></body></tt>` },
  { ext: 'dfxp', content: `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="3s">${soraniText.replace(/\n/g, '<br/>')}</p></div></body></tt>` }
];
const soraniFontCases = ['Noto Sans Arabic', 'Noto Naskh Arabic', 'Adobe Arabic', 'Arial', 'Segoe UI', 'Font Not Installed']
  .flatMap(font => [{ format: 'srt', font }, { format: 'ass', font }]);

describe.skipIf(!hasTools)('real FFmpeg', () => {
  let dir: string;
  let source: string;
  let srt: string;
  let status: FfmpegStatus;
  let media: MediaInfo;
  let baselineFrame: Buffer;

  beforeAll(async () => {
    // A folder and file name with Kurdish letters and spaces exercises the real argument path end to end.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozh-int-'));
    const folder = path.join(dir, 'فیلمی کوردی');
    fs.mkdirSync(folder);
    srt = path.join(folder, 'ژێرنووس.srt');
    fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,500\n<font face="Noto Sans Arabic">سڵاو چۆنی گەواد ڤیەگل</font>\n\n', 'utf8');
    const embedded = path.join(folder, 'embedded.srt');
    fs.writeFileSync(embedded, '1\n00:00:00,000 --> 00:00:02,500\nHello\n\n', 'utf8');
    source = path.join(folder, 'سڵاو movie.mkv');
    const made = run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-i', embedded, '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-c:s', 'srt', '-metadata:s:s:0', 'language=eng', source]);
    if (made.status !== 0) throw new Error(`fixture creation failed: ${made.stderr}`);
    status = await detectFfmpeg();
    media = await inspectMedia(source);
    const baselinePath = path.join(dir, 'baseline.png');
    const baseline = spawnSync(status.ffmpeg.path, [
      '-hide_banner', '-v', 'error', '-y', '-ss', '1.000', '-i', source,
      '-an', '-sn', '-dn', '-frames:v', '1', '-c:v', 'png', baselinePath
    ], { encoding: 'utf8' });
    if (baseline.status !== 0) throw new Error(`baseline frame creation failed: ${baseline.stderr}`);
    baselineFrame = fs.readFileSync(baselinePath);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const encode = async (over: Parameters<typeof baseSettings>[0], name: string) => {
    const output = path.join(dir, 'out', name);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const result = await startEncoding(baseSettings({ input: source, output, ...over }), media, () => {}).done;
    return { result, output };
  };
  const probe = (file: string) => JSON.parse(run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file]).stdout).streams as Array<Record<string, any>>;
  const expectSubtitlePreview = async (subtitle: string, label: string, subtitleEncoding: 'auto' | 'utf-8' = 'utf-8') => {
    const settings = baseSettings({
      input: source,
      output: path.join(dir, 'out', `render-${label}.mp4`),
      subtitleEncoding,
      subtitles: { mode: 'burn', source: { kind: 'external', file: subtitle } }
    });
    const preview = await renderSubtitlePreview(settings, 1);
    if (preview.status !== 'ok') throw new Error(`${label}: ${preview.error}`);
    const png = Buffer.from(preview.png, 'base64');
    expect(pngSize(png)).toEqual({ width: 640, height: 360 });
    expect(png.equals(baselineFrame)).toBe(false);
  };

  it('detects real binaries and encoders', () => {
    expect(status.available).toBe(true);
    expect(status.encoders).toContain('libx264');
  });

  it('inspects a Unicode path and finds video, audio and subtitle streams', () => {
    expect(media.video?.codec_name).toBe('h264');
    expect(media.audio).toHaveLength(1);
    expect(media.subtitles).toHaveLength(1);
    expect(media.duration).toBeGreaterThan(2);
  });

  it('MP4 + H.264 with a kept subtitle track produces a playable file', async () => {
    const { result, output } = await encode({ subtitles: { mode: 'keep', embedded: [2] } }, 'a.mp4');
    expect(result.status).toBe('complete');
    const types = probe(output).map(s => s.codec_type);
    expect(types).toEqual(expect.arrayContaining(['video', 'audio', 'subtitle']));
  });

  it('REGRESSION: scaling keeps the subtitle track and shrinks to an even, aspect-correct size', async () => {
    const { result, output } = await encode({ shortEdge: 240, container: 'mkv', output: path.join(dir, 'out', 'b.mkv'), subtitles: { mode: 'keep', embedded: [2] } }, 'b.mkv');
    expect(result.status).toBe('complete');
    const streams = probe(path.join(dir, 'out', 'b.mkv'));
    const video = streams.find(s => s.codec_type === 'video')!;
    expect([video.width, video.height]).toEqual([427 % 2 ? 426 : 428, 240]);
    expect(streams.some(s => s.codec_type === 'subtitle')).toBe(true);
    expect(output).toBeTruthy();
  });

  it('burns a Kurdish external subtitle from a Unicode path', async () => {
    setFallbackFontsDir(path.join(process.cwd(), 'resources', 'fonts'));
    try {
      const { result, output } = await encode({ subtitles: { mode: 'burn', source: { kind: 'external', file: srt } }, subtitleEncoding: 'utf-8' }, 'c.mp4');
      expect(result.status, JSON.stringify(result)).toBe('complete');
      expect(probe(output).some(s => s.codec_type === 'subtitle')).toBe(false);
    } finally {
      setFallbackFontsDir(undefined);
    }
  });

  it.each(soraniSubtitleCases)('renders Sorani sentences from .$ext with the real preview pipeline', async ({ ext, content }) => {
    setFallbackFontsDir(path.join(process.cwd(), 'resources', 'fonts'));
    try {
      const subtitle = path.join(dir, `render-${ext}.` + ext.replace('microdvd.', ''));
      fs.writeFileSync(subtitle, content, 'utf8');
      await expectSubtitlePreview(subtitle, ext);
    } finally {
      setFallbackFontsDir(undefined);
    }
  });

  it.each(soraniFontCases)('renders Sorani Kurdish glyphs with $font in $format subtitles', async ({ format, font }) => {
    setFallbackFontsDir(path.join(process.cwd(), 'resources', 'fonts'));
    try {
      const subtitle = path.join(dir, `font-${format}-${font.replace(/[^A-Za-z0-9]+/g, '-')}.${format}`);
      const content = format === 'srt'
        ? `1\n00:00:00,000 --> 00:00:03,000\n${soraniText.split('\n').map(line => `<font face="${font}">${line}</font>`).join('\n')}\n`
        : soraniAss('v4.00+', font);
      fs.writeFileSync(subtitle, content, 'utf8');
      await expectSubtitlePreview(subtitle, `font-${format}-${font}`);
    } finally {
      setFallbackFontsDir(undefined);
    }
  });

  it.each([
    { label: 'UTF-8 with BOM', bytes: (text: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]) },
    { label: 'UTF-16LE with BOM', bytes: (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) },
    { label: 'UTF-16BE with BOM', bytes: (text: string) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]) },
    { label: 'BOM-less UTF-16LE', bytes: (text: string) => Buffer.from(text, 'utf16le') }
  ])('renders complex Sorani encoded as $label', async ({ label, bytes }) => {
    setFallbackFontsDir(path.join(process.cwd(), 'resources', 'fonts'));
    try {
      const subtitle = path.join(dir, `encoding-${label.replace(/[^A-Za-z0-9]+/g, '-')}.srt`);
      const content = `1\n00:00:00,000 --> 00:00:03,000\n${soraniText}\n`;
      fs.writeFileSync(subtitle, bytes(content));
      await expectSubtitlePreview(subtitle, `encoding-${label}`, 'auto');
    } finally {
      setFallbackFontsDir(undefined);
    }
  });

  it('WebM with VP9 + Opus works', async () => {
    const { result } = await encode({ container: 'webm', videoEncoder: 'libvpx-vp9', audioMode: 'opus', speed: 'fast', output: path.join(dir, 'out', 'd.webm') }, 'd.webm');
    expect(result.status, JSON.stringify(result)).toBe('complete');
  });

  it('SVT-AV1 works with the numeric preset', async function () {
    if (!status.encoders.includes('libsvtav1')) return;
    const { result } = await encode({ container: 'mkv', videoEncoder: 'libsvtav1', speed: 'fast', output: path.join(dir, 'out', 'e.mkv') }, 'e.mkv');
    expect(result.status, JSON.stringify(result)).toBe('complete');
  });

  it('a cancelled encode leaves no output and no partial file', async () => {
    const output = path.join(dir, 'out', 'f.mkv');
    const job = startEncoding(baseSettings({ input: source, output, container: 'mkv', videoEncoder: 'libx265', speed: 'slow' }), media, () => {});
    setTimeout(() => job.cancel(), 150);
    const result = await job.done;
    expect(['cancelled', 'complete']).toContain(result.status);
    if (result.status === 'cancelled') {
      expect(fs.existsSync(output)).toBe(false);
      expect(fs.readdirSync(path.dirname(output)).filter(n => n.includes('partial')).filter(n => n.startsWith('f.'))).toEqual([]);
    }
  });

  it('a corrupt input is reported as a readable error', async () => {
    const bad = path.join(dir, 'bad.mkv');
    fs.writeFileSync(bad, 'this is not a video');
    await expect(inspectMedia(bad)).rejects.toThrow();
  });

  describe('burning an embedded Arabic subtitle track', () => {
    afterEach(() => setFallbackFontsDir(undefined));

    it('detects it, repairs it and offers fallback fonts without forcing any font', async () => {
      // A dedicated fixture: reusing the shared `source`/`media` above would also change their
      // subtitle count and break the unrelated assertions earlier in this file that depend on it.
      const arSrt = path.join(dir, 'ar-embedded.srt');
      fs.writeFileSync(arSrt, '1\n00:00:00,000 --> 00:00:02,500\nسڵاو، ئەمە تاقیکردنەوەیەکە\n\n', 'utf8');
      const arSource = path.join(dir, 'ar-source.mkv');
      const made = run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=2',
        '-i', arSrt, '-map', '0:v', '-map', '1:s', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:s', 'srt', arSource]);
      if (made.status !== 0) throw new Error(`fixture creation failed: ${made.stderr}`);
      const arMedia = await inspectMedia(arSource);
      const stream = arMedia.subtitles[0];
      expect(stream).toBeTruthy();

      const fontsDir = path.join(process.cwd(), 'resources', 'fonts');
      setFallbackFontsDir(fontsDir);
      const output = path.join(dir, 'out', 'ar-embedded.mp4');
      fs.mkdirSync(path.dirname(output), { recursive: true });
      const job = startEncoding(
        baseSettings({ input: arSource, output, subtitles: { mode: 'burn', source: { kind: 'embedded', streamIndex: stream.index } } }),
        arMedia,
        () => {}
      );
      expect(job.command).toContain('fontsdir=');
      expect(job.command).not.toMatch(/force_style|FontName/);
      const result = await job.done;
      expect(result.status, JSON.stringify(result)).toBe('complete');
    });

    it('leaves a non-Arabic embedded track alone', async () => {
      const fontsDir = path.join(process.cwd(), 'resources', 'fonts');
      setFallbackFontsDir(fontsDir);
      const output = path.join(dir, 'out', 'en-embedded.mp4');
      fs.mkdirSync(path.dirname(output), { recursive: true });
      // `source`/`media` from the outer fixture carry the English "Hello" embedded track.
      const job = startEncoding(
        baseSettings({ input: source, output, subtitles: { mode: 'burn', source: { kind: 'embedded', streamIndex: media.subtitles[0].index } } }),
        media,
        () => {}
      );
      expect(job.command).not.toContain('fontsdir=');
      const result = await job.done;
      expect(result.status, JSON.stringify(result)).toBe('complete');
    });
  });
});

describe.skipIf(hasTools)('real FFmpeg (not installed here)', () => {
  it.skip('skipped: install FFmpeg and FFprobe on PATH to run the real-encode tests', () => {});
});
