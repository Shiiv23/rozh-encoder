import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeSubtitleBytes, fixArabicSubtitleText, prepareExternalSubtitle } from './subtitleText';

const RLE = '\u202B';
const PDF = '\u202C';

describe('Arabic presentation-form normalization', () => {
  it('keeps natural isolated and connected lam-alef ligatures for Arabic glyph fallback', () => {
    const out = fixArabicSubtitleText('لا الكلام', 'srt');
    expect(out).toContain('\uFEFB');
    expect(out).toContain('\uFEFC');
    expect(out).not.toContain('\u200D');
  });
  it('normalizes authored presentation forms and remains idempotent without changing font tags', () => {
    const once = fixArabicSubtitleText('{\\an8}لا يقول bold', 'ass');
    expect(fixArabicSubtitleText(once, 'ass')).toBe(once);
    expect(fixArabicSubtitleText('قال \uFEFB يقول', 'srt')).toContain('قال \uFEFB يقول');
    expect(once).toContain('{\\an8}');
  });
});

describe('decodeSubtitleBytes', () => {
  it('reads plain UTF-8 as-is', () => {
    const out = decodeSubtitleBytes(Buffer.from('سڵاو ڕۆژ', 'utf8'));
    expect(out).toEqual({ text: 'سڵاو ڕۆژ', transcoded: false });
  });

  it('strips a UTF-8 BOM and decodes UTF-16 (with BOM, LE and BE)', () => {
    expect(decodeSubtitleBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ئەمە')])).text).toBe('ئەمە');
    expect(decodeSubtitleBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ئەمە', 'utf16le')])).text).toBe('ئەمە');
    const be = Buffer.from('ئەمە', 'utf16le').swap16();
    expect(decodeSubtitleBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).text).toBe('ئەمە');
  });

  it('detects BOM-less UTF-16', () => {
    expect(decodeSubtitleBytes(Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nسڵاو\n', 'utf16le')).text).toContain('سڵاو');
  });

  it('guesses Windows-1256 for non-UTF-8 Arabic files in Automatic mode, and honours an explicit choice', () => {
    const bytes = Buffer.from([0xe3, 0xd1, 0xcd, 0xc8, 0xc7]); // مرحبا
    expect(decodeSubtitleBytes(bytes, 'auto')).toEqual({ text: 'مرحبا', transcoded: true });
    expect(decodeSubtitleBytes(bytes, 'cp1256').text).toBe('مرحبا');
  });

  it('falls back to Windows-1254 for non-UTF-8 Kurmanji text', () => {
    expect(decodeSubtitleBytes(Buffer.from([0xea, 0xee]), 'auto').text).toBe('êî');
  });
});

describe('fixArabicSubtitleText', () => {
  const soraniSentences = [
    'سڵاو چۆنی گەواد ڤیەگل؟',
    'باشم، سوپاس بۆ پرسیارەکەت.',
    'ئەمڕۆ ڕۆژێکی جوانە و دەمەوێت بە کوردی قسە بکەم.',
    'ڕ، ڵ، ۆ، ێ، ە، ڤ، گ، چ، پ، ژ.'
  ];

  it('normalizes presentation forms but preserves lam-alef glyphs and other punctuation', () => {
    const out = fixArabicSubtitleText('قال \uFEFB يريد… “ok” ½', 'srt');
    expect(out).toContain('\uFEFB');
    expect(out).toContain('… “ok” ½'); // NFKC would have turned these into "...", "ok", "1⁄2"
  });

  it('keeps Kurdish zero-width non-joiners intact', () => {
    expect(fixArabicSubtitleText('ئەو دەڵێ‌ن', 'srt')).toContain('\u200C');
  });

  it('SRT: embeds RTL lines starting with a number, but leaves Arabic-first lines, timing, and English alone', () => {
    const out = fixArabicSubtitleText('1\r\n00:00:00,000 --> 00:00:02,000\r\n2026 ساڵی نوێ!\r\nHello there\r\n', 'srt');
    expect(out).toBe(`1\r\n00:00:00,000 --> 00:00:02,000\r\n${RLE}2026 ساڵی نوێ!${PDF}\r\nHello there\r\n`);
    expect(fixArabicSubtitleText('سڵاو 2026', 'srt')).toBe('سڵاو 2026');
  });

  it('SRT: leaves Arabic-first markup and authored direction alone, but handles numeric-first markup', () => {
    expect(fixArabicSubtitleText('\u200Eسڵاو', 'srt')).toBe('\u200Eسڵاو');
    expect(fixArabicSubtitleText('<font face="Adobe Arabic" color="#fff">سڵاو چۆنی گەواد ڤیەگل</font>', 'srt'))
      .toBe('<font face="Adobe Arabic" color="#fff">سڵاو چۆنی گەواد ڤیەگل</font>');
    expect(fixArabicSubtitleText('<font face="Arial">2026 ساڵ</font>', 'srt')).toContain(`${RLE}<font face="Arial">2026 ساڵ</font>${PDF}`);
  });

  const ass = (wrap: string, spacing: string, text: string) => [
    '[Script Info]', `WrapStyle: ${wrap}`, '', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, Spacing, Alignment',
    `Style: Default,Rudaw,28,${spacing},2`, '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,${text}`, ''
  ].join('\n');

  it('ASS: preserves authored layout, spacing and font tags, embedding only text with an LTR lead', () => {
    const out = fixArabicSubtitleText(ass('2', '4', '{\\fnBahij Nassim\\fsp5\\q2}سڵاو, جیهان\\Nدووەم'), 'ass');
    expect(out).toContain('WrapStyle: 2');
    expect(out).toContain('Style: Default,Rudaw,28,4,2');
    expect(out).toContain('{\\fnBahij Nassim\\fsp5\\q2}سڵاو, جیهان\\Nدووەم');
    const mixedLead = fixArabicSubtitleText(ass('2', '4', '{\\an8}2026 ساڵی نوێ'), 'ass');
    expect(mixedLead).toContain(`{\\an8}${RLE}2026 ساڵی نوێ${PDF}`);
  });

  it('ASS: normalizes presentation-form dialogue text while preserving Kurdish letters and authored fonts', () => {
    const source = ass('2', '0', '{\\fnAdobe Arabic}\uFE91ڵ ۆێڕڤگچپژ');
    const once = fixArabicSubtitleText(source, 'ass');
    expect(once).toContain('{\\fnAdobe Arabic}بڵ ۆێڕڤگچپژ');
    expect(fixArabicSubtitleText(once, 'ass')).toBe(once);
  });

  it('preserves complete Sorani sentences, punctuation, numbers, and Kurdish-specific letters in SRT and ASS', () => {
    const srt = fixArabicSubtitleText(soraniSentences.join('\n'), 'srt');
    const assText = fixArabicSubtitleText(ass('2', '0', soraniSentences.join('\\N')), 'ass');
    for (const sentence of soraniSentences) {
      expect(srt).toContain(sentence);
      expect(assText).toContain(sentence);
    }
    expect(fixArabicSubtitleText('2026 ساڵی نوێ!', 'srt')).toContain('2026 ساڵی نوێ!');
  });

  it('ASS: preserves every authored wrap style and Latin-only text', () => {
    for (const wrap of ['0', '1', '2', '3']) {
      const out = fixArabicSubtitleText(ass(wrap, '0', 'Latin, words, 1,2,3'), 'ass');
      expect(out).toContain(`WrapStyle: ${wrap}`);
      expect(out).toContain('Latin, words, 1,2,3');
    }
  });

  it('ASS: leaves Arabic-first text without redundant direction controls', () => {
    const out = fixArabicSubtitleText(ass('3', '0', 'سڵاو, جیهان, 1,2,3'), 'ass');
    expect(out).toContain('WrapStyle: 3');
    expect(out).toContain(',,سڵاو, جیهان, 1,2,3');
  });

  it('ASS: does not insert a tatweel into an Arabic-first cue', () => {
    const cue = '{\\blur1}أتيت في وقت مناسب يا فوس';
    const out = fixArabicSubtitleText(ass('0', '0', cue), 'ass');
    expect(out).toContain(`,,${cue}`);
    expect(out).not.toContain('\u0640');
  });
});

describe('prepareExternalSubtitle', () => {
  const dirs: string[] = [];
  const write = (name: string, data: string | Buffer): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozh-subs-test-'));
    dirs.push(dir);
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    return file;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns plain UTF-8 non-Arabic files untouched', () => {
    const file = write('en.srt', '1\n00:00:00,000 --> 00:00:01,000\nHello\n');
    expect(prepareExternalSubtitle(file)).toMatchObject({ path: file, arabic: false, utf8: false });
  });

  it('writes a repaired UTF-8 copy of an Arabic file, keeping its name and extension', () => {
    const file = write('کوردی.ass', ass());
    const out = prepareExternalSubtitle(file);
    expect(out.arabic).toBe(true);
    expect(out.utf8).toBe(true);
    expect(path.basename(out.path)).toBe('کوردی.ass');
    expect(out.path).not.toBe(file);
    expect(fs.readFileSync(out.path, 'utf8')).toContain('WrapStyle: 2');
    expect(fs.readFileSync(out.path, 'utf8')).toContain('Style: Default,Rudaw,3');
    expect(fs.readFileSync(file, 'utf8')).toContain('WrapStyle: 2'); // original never modified
  });

  it('re-encodes a non-UTF-8 non-Arabic file in Automatic mode, but leaves explicit legacy choices to FFmpeg', () => {
    const bytes = Buffer.concat([Buffer.from('1\n00:00:00,000 --> 00:00:01,000\n'), Buffer.from([0xea, 0xee]), Buffer.from('\n')]);
    const file = write('kurmanji.srt', bytes);
    const auto = prepareExternalSubtitle(file, 'auto');
    expect(auto.utf8).toBe(true);
    expect(fs.readFileSync(auto.path, 'utf8')).toContain('êî');
    expect(prepareExternalSubtitle(file, 'cp1254')).toMatchObject({ path: file, utf8: false });
  });

  it('falls back to the original path if the file cannot be read', () => {
    const missing = path.join(os.tmpdir(), 'rozh-subs-test-missing', 'nope.srt');
    expect(prepareExternalSubtitle(missing).path).toBe(missing);
  });

  function ass(): string {
    return '[Script Info]\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Spacing\nStyle: Default,Rudaw,3\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,سڵاو\n';
  }
});
