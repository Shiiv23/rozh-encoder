// Text-level preparation of Arabic-script (Arabic, Sorani Kurdish, Persian, Urdu…) subtitles
// before libass renders them into the picture. Nothing in here ever touches a FONT: whatever
// family the subtitle file asks for (an .ass Style's Fontname, an inline \fn tag, an SRT
// <font face="…"> tag) is left exactly as authored, and libass resolves it against the fonts
// installed on the user's own device. This module only repairs the things that make
// correctly-fonted Arabic text burn in wrong:
//
//   1. Text encoding. Legacy files (Windows-1256, UTF-16, BOM-less) are decoded here and handed
//      to FFmpeg as clean UTF-8, so burning never depends on FFmpeg having been built with iconv.
//   2. Presentation-form codepoints in SRT and ASS dialogue text are normalized for shaping;
//      lam-alef is kept as a presentation glyph so libass can use an Arabic fallback glyph if needed.
//   3. Bidirectional order. Arabic text that starts with a number or Latin word can be laid out
//      left-to-right (scrambled word order, punctuation on the wrong side), so only those lines
//      receive explicit RTL embedding marks. ASS styling, positions, spacing and line breaks are
//      kept exactly as authored.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SubtitleEncoding } from './types';

// Arabic, Arabic Supplement, Arabic Extended-A, and the Arabic Presentation Forms blocks. Sorani
// Kurdish is written in Arabic script (with a few extra letters — ڕ ڵ ۆ ێ گ چ پ ژ ڤ — that live in
// the base Arabic block), so this also catches Kurdish subtitle text, not just Arabic proper.
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ARABIC_LETTER = /[\u0620-\u064A\u066E-\u06D3\u06D5\u06EE-\u06EF\u06FA-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]/g;
const LATIN_LETTER = /[A-Za-z\u00C0-\u024F]/g;

const RLE = '\u202B';
const PDF = '\u202C';
// Explicit direction marks that mean the author already chose a direction for this line.
const EXPLICIT_DIRECTION_START = /^[\u200E\u202A\u202B\u202D\u202E\u2066-\u2069]/;
const ARABIC_LETTER_CHAR = /[\u0620-\u064A\u066E-\u06D3\u06D5\u06EE-\u06EF\u06FA-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]/;
const LATIN_LETTER_CHAR = /[A-Za-z\u00C0-\u024F]/;
const NUMBER_CHAR = /[0-9\u0660-\u0669\u06F0-\u06F9]/;

/** True if `text` contains any Arabic-script character (Arabic, Persian, Sorani Kurdish, Urdu, …). */
export function hasArabicScript(text: string): boolean {
  return ARABIC_SCRIPT.test(text);
}

// ---------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------

const LEGACY_LABELS: Partial<Record<SubtitleEncoding, string>> = {
  cp1256: 'windows-1256',
  cp1254: 'windows-1254',
  cp1252: 'windows-1252',
  cp1251: 'windows-1251'
};

function looksLikeBomlessUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | undefined {
  const sample = Math.min(bytes.length, 4096) & ~1;
  if (sample < 8) return undefined;
  let zeroEven = 0;
  let zeroOdd = 0;
  for (let i = 0; i < sample; i += 2) {
    if (bytes[i] === 0) zeroEven++;
    if (bytes[i + 1] === 0) zeroOdd++;
  }
  const pairs = sample / 2;
  if (zeroOdd > pairs * 0.3 && zeroEven < pairs * 0.05) return 'utf-16le';
  if (zeroEven > pairs * 0.3 && zeroOdd < pairs * 0.05) return 'utf-16be';
  return undefined;
}

export interface DecodedSubtitle {
  text: string;
  /** True when the bytes were NOT plain UTF-8 (legacy codepage or UTF-16), i.e. FFmpeg would misread the original. */
  transcoded: boolean;
}

/**
 * Turns the raw bytes of a subtitle file into text. A byte-order mark always wins. Otherwise a
 * legacy codepage chosen by the user is honoured; with "Automatic" or "UTF-8", valid UTF-8 is
 * used as-is, and anything else is recognised as BOM-less UTF-16 or guessed to be Windows-1256
 * (the usual encoding of old Arabic subtitle files) or Windows-1254 (Kurmanji Kurdish).
 */
export function decodeSubtitleBytes(bytes: Uint8Array, choice: SubtitleEncoding = 'auto'): DecodedSubtitle {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), transcoded: true };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), transcoded: true };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(bytes), transcoded: false };

  const legacy = LEGACY_LABELS[choice];
  if (legacy) return { text: new TextDecoder(legacy).decode(bytes), transcoded: true };

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), transcoded: false };
  } catch {
    if (choice === 'utf-8') return { text: new TextDecoder('utf-8').decode(bytes), transcoded: false };
  }

  const utf16 = looksLikeBomlessUtf16(bytes);
  if (utf16) return { text: new TextDecoder(utf16).decode(bytes), transcoded: true };

  const arabic = new TextDecoder('windows-1256').decode(bytes);
  const high = [...arabic].filter(ch => ch.charCodeAt(0) > 0x7f);
  const arabicShare = high.length ? high.filter(ch => ARABIC_SCRIPT.test(ch)).length / high.length : 0;
  if (arabicShare >= 0.5) return { text: arabic, transcoded: true };
  return { text: new TextDecoder('windows-1254').decode(bytes), transcoded: true };
}

// ---------------------------------------------------------------------------------------------
// Text repairs
// ---------------------------------------------------------------------------------------------

/** Presentation forms → base letters (NFKC on just those blocks, so Latin text and punctuation are never altered); strips stray BOMs/NULs. */
function normalizeArabicText(text: string): string {
  const normalized = text
    .replace(/[\uFEFF\u0000]/g, '')
    .replace(/[\uFB50-\uFDFF\uFE70-\uFEFE]+/g, run => run.normalize('NFKC'));
  return preserveLamAlefLigatures(normalized);
}

const LAM_ALEF = /(\u0644)((?:[\u064B-\u065F\u0670]*))([\u0622\u0623\u0625\u0627])/g;
const ARABIC_LETTER_BASE = /[\u0620-\u064A\u066E-\u06D3\u06FA-\u06FF\u0750-\u077F\u08A0-\u08C9]/;
const NON_JOINING_FORWARD = /[\u0622-\u0625\u0627\u0629\u062F-\u0632\u0648\u0649\u0671-\u0677\u0688\u0691\u0698\u06C0\u06C3-\u06CB\u06CD\u06CF\u06D2-\u06D3]/;
const ARABIC_MARK = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u08D3-\u08FF]/;
const LAM_ALEF_FORMS: Record<string, readonly [isolated: string, final: string]> = {
  '\u0622': ['\uFEF5', '\uFEF6'],
  '\u0623': ['\uFEF7', '\uFEF8'],
  '\u0625': ['\uFEF9', '\uFEFA'],
  '\u0627': ['\uFEFB', '\uFEFC']
};

function previousCodePoint(text: string, index: number): string | undefined {
  let end = index;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    const start = code >= 0xDC00 && code <= 0xDFFF && end > 1
      && text.charCodeAt(end - 2) >= 0xD800 && text.charCodeAt(end - 2) <= 0xDBFF
      ? end - 2
      : end - 1;
    const char = text.slice(start, end);
    if (!ARABIC_MARK.test(char)) return char;
    end = start;
  }
  return undefined;
}

function preserveLamAlefLigatures(text: string): string {
  return text.replace(LAM_ALEF, (match, _lam: string, marks: string, alef: string, offset: number, source: string) => {
    const form = LAM_ALEF_FORMS[alef];
    if (!form) return match;
    const previous = previousCodePoint(source, offset);
    const joinsFromPrevious = previous !== undefined
      && ARABIC_LETTER_BASE.test(previous)
      && !NON_JOINING_FORWARD.test(previous);
    return `${joinsFromPrevious ? form[1] : form[0]}${marks}`;
  });
}

/** Letters in `line` once markup (HTML-style and ASS override blocks) is removed. */
function countLetters(line: string): { arabic: number; latin: number } {
  const bare = line.replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '');
  return { arabic: (bare.match(ARABIC_LETTER) ?? []).length, latin: (bare.match(LATIN_LETTER) ?? []).length };
}

/** True if a line should be laid out right-to-left: mostly Arabic-script, not an English line with one borrowed word. */
function isRtlLine(line: string): boolean {
  const { arabic, latin } = countLetters(line);
  return arabic > 0 && arabic * 2 >= latin;
}

function startsWithRtlLetter(line: string): boolean {
  const bare = line.replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').trimStart();
  for (const char of bare) {
    if (ARABIC_LETTER_CHAR.test(char)) return true;
    if (LATIN_LETTER_CHAR.test(char) || NUMBER_CHAR.test(char)) return false;
  }
  return false;
}

/** Wraps `body` only when an RTL line starts with an LTR character or number. */
function embedRtl(lead: string, body: string): string {
  if (!body.trim() || !isRtlLine(body) || startsWithRtlLetter(body) || EXPLICIT_DIRECTION_START.test(body)) return lead + body;
  return `${lead}${RLE}${body}${PDF}`;
}

function fixSrt(text: string): string {
  return text
    .split('\n')
    .map(rawLine => {
      const cr = rawLine.endsWith('\r') ? '\r' : '';
      const line = cr ? rawLine.slice(0, -1) : rawLine;
      if (line.includes('-->') || !ARABIC_SCRIPT.test(line)) return rawLine;
      return embedRtl('', line) + cr;
    })
    .join('\n');
}

function splitCsv(line: string, columns: number): string[] {
  const parts: string[] = [];
  let rest = line;
  for (let i = 0; i < columns - 1; i++) {
    const comma = rest.indexOf(',');
    if (comma < 0) break;
    parts.push(rest.slice(0, comma));
    rest = rest.slice(comma + 1);
  }
  parts.push(rest);
  return parts;
}

function fixAssDialogueText(text: string): string {
  return text
    .split('\\N')
    .map(segment => {
      if (!ARABIC_SCRIPT.test(segment)) return segment;
      const lead = /^\s*(?:\{[^}]*\})*/.exec(segment)?.[0] ?? '';
      const body = segment.slice(lead.length).split(/(\{[^}]*\}|<[^>]*>)/g)
        .map(part => /^(?:\{[^}]*\}|<[^>]*>)$/.test(part) ? part : normalizeArabicText(part))
        .join('');
      return embedRtl(lead, body);
    })
    .join('\\N');
}

function fixAss(text: string): string {
  let section = '';
  let eventTextCol = -1;
  let eventColumns = 0;
  return text
    .split('\n')
    .map(rawLine => {
      const cr = rawLine.endsWith('\r') ? '\r' : '';
      const line = cr ? rawLine.slice(0, -1) : rawLine;
      const header = /^\s*\[(.+?)\]\s*$/.exec(line);
      if (header) { section = header[1].toLowerCase(); return rawLine; }

      if (section === 'events') {
        const format = /^\s*Format\s*:\s*(.*)$/i.exec(line);
        if (format) {
          const names = format[1].split(',').map(s => s.trim().toLowerCase());
          eventColumns = names.length;
          eventTextCol = names.indexOf('text');
          return rawLine;
        }
        const dialogue = /^(\s*Dialogue\s*:\s*)(.*)$/i.exec(line);
        if (dialogue && eventTextCol >= 0) {
          const fields = splitCsv(dialogue[2], eventColumns);
          if (fields.length > eventTextCol) fields[eventTextCol] = fixAssDialogueText(fields[eventTextCol]);
          return `${dialogue[1]}${fields.join(',')}${cr}`;
        }
      }
      return rawLine;
    })
    .join('\n');
}

/**
 * Applies every Arabic-script repair listed at the top of this file to decoded subtitle text.
 * `format` is how libass will read the result: 'srt' for SubRip-style text, 'ass' for Advanced
 * SubStation (which is also what FFmpeg converts every other text format into).
 */
export function fixArabicSubtitleText(text: string, format: 'srt' | 'ass'): string {
  return format === 'ass' ? fixAss(text) : fixSrt(normalizeArabicText(text));
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export interface PreparedSubtitle {
  /** File FFmpeg should read: the original when nothing needed changing, otherwise a UTF-8 temp copy. */
  path: string;
  /** Temp directory to delete afterwards, when one was created. */
  tempDir?: string;
  /** The text contains Arabic-script characters. */
  arabic: boolean;
  /** `path` is UTF-8 already, so the user's subtitle-encoding choice must no longer be applied to it. */
  utf8: boolean;
  /** Text format of `path`: 'srt' and 'ass' have been repaired; 'other' (WebVTT, SAMI, …) is decoded only and still needs converting to ASS before repairs apply. */
  format: 'srt' | 'ass' | 'other';
}

function textFormatOf(filePath: string): PreparedSubtitle['format'] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.srt') return 'srt';
  if (ext === '.ass' || ext === '.ssa') return 'ass';
  return 'other';
}

function writeTemp(sourcePath: string, text: string): { file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozh-subs-'));
  const file = path.join(dir, path.basename(sourcePath));
  fs.writeFileSync(file, text, 'utf8');
  return { file, dir };
}

/**
 * Prepares an external subtitle file for burning. Files that are plain UTF-8 and not Arabic-script
 * are returned untouched. Never throws — on any failure the original path is returned, because
 * a slightly imperfect caption beats a failed encode.
 */
export function prepareExternalSubtitle(sourcePath: string, encoding: SubtitleEncoding = 'auto'): PreparedSubtitle {
  const format = textFormatOf(sourcePath);
  const untouched: PreparedSubtitle = { path: sourcePath, arabic: false, utf8: false, format };
  try {
    const decoded = decodeSubtitleBytes(fs.readFileSync(sourcePath), encoding);
    const arabic = hasArabicScript(decoded.text);
    // A non-UTF-8 file in "Automatic" mode is re-encoded too (FFmpeg would otherwise assume UTF-8
    // and print garbage); with an explicit legacy choice and non-Arabic text FFmpeg's own iconv path is kept.
    const reencode = arabic || (decoded.transcoded && encoding === 'auto');
    if (!reencode) return untouched;
    const text = arabic && format !== 'other' ? fixArabicSubtitleText(decoded.text, format) : decoded.text;
    const { file, dir } = writeTemp(sourcePath, text);
    return { path: file, tempDir: dir, arabic, utf8: true, format };
  } catch {
    return untouched;
  }
}
