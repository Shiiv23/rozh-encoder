import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeSubtitleForFfmpeg } from './subtitleConvert';

describe('normalizeSubtitleForFfmpeg', () => {
  const tempFiles: string[] = [];
  const write = (name: string, text: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozh-subs-convert-test-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, text, 'utf8');
    tempFiles.push(dir);
    return file;
  };

  afterEach(() => {
    for (const dir of tempFiles.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves natively-supported formats (.srt, .ass, .ssa, .vtt, .smi) completely untouched', () => {
    for (const ext of ['.srt', '.ass', '.ssa', '.vtt', '.smi']) {
      const file = write(`in${ext}`, 'whatever content, never parsed');
      const result = normalizeSubtitleForFfmpeg(file);
      expect(result.path).toBe(file);
      expect(result.tempDir).toBeUndefined();
    }
  });

  it('leaves SubViewer-style .sub files untouched — FFmpeg already demuxes those correctly', () => {
    const file = write('in.sub', '0:00:00.599,0:00:04.160\nHello there.\n');
    const result = normalizeSubtitleForFfmpeg(file);
    expect(result.path).toBe(file);
  });

  it('converts MicroDVD .sub files to .srt, using the source video frame rate', () => {
    const file = write('in.sub', '{0}{50}Hello there.\n{60}{100}Second line.\n');
    const result = normalizeSubtitleForFfmpeg(file, 25);
    expect(result.path).not.toBe(file);
    expect(result.path.endsWith('.srt')).toBe(true);
    const srt = fs.readFileSync(result.path, 'utf8');
    expect(srt).toContain('00:00:00,000 --> 00:00:02,000');
    expect(srt).toContain('Hello there.');
    expect(srt).toContain('00:00:02,400 --> 00:00:04,000');
    expect(srt).toContain('Second line.');
  });

  it('honors a MicroDVD framerate declaration in the first line over the fallback', () => {
    const file = write('in.sub', '{1}{1}50\n{0}{50}Hello there.\n');
    const result = normalizeSubtitleForFfmpeg(file, 25);
    const srt = fs.readFileSync(result.path, 'utf8');
    expect(srt).toContain('00:00:00,000 --> 00:00:01,000'); // 50 frames at 50fps = 1s, not 2s
  });

  it('converts .mpl2 files to .srt (bracketed numbers are tenths of a second)', () => {
    const file = write('in.mpl2', '[0][100]Hello there.\n[110][200]Second line.\n');
    const result = normalizeSubtitleForFfmpeg(file);
    const srt = fs.readFileSync(result.path, 'utf8');
    expect(srt).toContain('00:00:00,000 --> 00:00:10,000');
    expect(srt).toContain('Hello there.');
    expect(srt).toContain('00:00:11,000 --> 00:00:20,000');
  });

  it('converts .sbv (YouTube) files to .srt', () => {
    const file = write('in.sbv', '0:00:00.599,0:00:04.160\nHello there.\n\n0:00:04.160,0:00:06.720\nSecond line.\n');
    const result = normalizeSubtitleForFfmpeg(file);
    const srt = fs.readFileSync(result.path, 'utf8');
    expect(srt).toContain('00:00:00,599 --> 00:00:04,160');
    expect(srt).toContain('Hello there.');
    expect(srt).toContain('00:00:04,160 --> 00:00:06,720');
  });

  it('converts .ttml files to .srt, decoding entities and <br/> line breaks', () => {
    const ttml = `<?xml version="1.0"?>
<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
<p begin="00:00:01.000" end="00:00:04.000">Hello world<br/>second line</p>
<p begin="00:00:04.500" end="00:00:06.000">Cats &amp; dogs</p>
</div></body></tt>`;
    const file = write('in.ttml', ttml);
    const result = normalizeSubtitleForFfmpeg(file);
    const srt = fs.readFileSync(result.path, 'utf8');
    expect(srt).toContain('00:00:01,000 --> 00:00:04,000');
    expect(srt).toContain('Hello world\nsecond line');
    expect(srt).toContain('Cats & dogs');
  });

  it('treats .dfxp the same as .ttml', () => {
    const dfxp = '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:00:12" end="00:00:02:00">Frame-based</p></div></body></tt>';
    const file = write('in.dfxp', dfxp);
    const result = normalizeSubtitleForFfmpeg(file, 24);
    const srt = fs.readFileSync(result.path, 'utf8');
    expect(srt).toContain('00:00:00,500 --> 00:00:02,000'); // 12 frames at 24fps = 0.5s
    expect(srt).toContain('Frame-based');
  });

  it('falls back to the original path if nothing recognizable could be parsed out', () => {
    const file = write('in.mpl2', 'not actually mpl2 content at all');
    const result = normalizeSubtitleForFfmpeg(file);
    expect(result.path).toBe(file);
  });

  it('falls back to the original path if the file cannot be read', () => {
    const missing = path.join(os.tmpdir(), 'rozh-subs-convert-test-missing', 'nope.mpl2');
    expect(normalizeSubtitleForFfmpeg(missing).path).toBe(missing);
  });
});
