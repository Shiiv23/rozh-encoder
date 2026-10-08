// Rozh accepts far more external subtitle formats than FFmpeg's own demuxers understand.
// FFmpeg (with libass) natively reads .srt, .ass, .ssa, .vtt and .smi straight off disk — those
// are passed through completely untouched, which matters most for .ass/.ssa: their [V4+ Styles]
// section is what "the font used in the translation file" actually means, and burning them in
// must preserve that rather than flattening it. Everything else Rozh advertises support for
// (MicroDVD .sub, .mpl2, YouTube .sbv, TTML/DFXP) either has no FFmpeg demuxer at all (TTML/DFXP),
// or FFmpeg's own format-probing misdetects it — verified against FFmpeg 6.1 on this project's own
// samples: a two-cue .mpl2 file scores as "lrc" and silently produces zero subtitle events (no
// error, just a burned video with no captions), and MicroDVD's "{start}{end}text" line shape often
// fails the demuxer's content probe outright ("Invalid data found when processing input") unless
// the caller forces `-f microdvd`, which the `subtitles` burn-in filter has no way to do. Rather
// than depend on FFmpeg's probing heuristics (which can vary by build/platform) for formats this
// fragile, this module converts them itself, deterministically, into a plain .srt file before
// FFmpeg ever sees them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeSubtitleBytes } from './subtitleText';
import type { SubtitleEncoding } from './types';

interface Cue { start: number; end: number; text: string }

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function srtTimestamp(totalSeconds: number): string {
  const ms = Math.max(0, Math.round((Number.isFinite(totalSeconds) ? totalSeconds : 0) * 1000));
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1000))},${pad(ms % 1000, 3)}`;
}

function cuesToSrt(cues: Cue[]): string {
  return cues
    .filter(c => c.text.trim().length > 0 && c.end > c.start)
    .map((c, i) => `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(c.end)}\n${c.text.trim()}\n`)
    .join('\n');
}

/** MicroDVD: `{startFrame}{endFrame}text`, one cue per line, `|` marks a manual line break. */
function looksLikeMicrodvd(text: string): boolean {
  return /^\s*\{\d+\}\{\d+\}/.test(text);
}

function microdvdToSrt(text: string, fallbackFps: number): string {
  const cues: Cue[] = [];
  let fps = fallbackFps;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\{(\d+)\}\{(\d+)\}(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, startFrame, endFrame, rawText] = match;
    // By convention the very first "cue" is sometimes just the framerate (e.g. `{1}{1}23.976`)
    // rather than an actual caption — a bare number with no other content.
    if (cues.length === 0 && Number(startFrame) <= 1 && /^\d+(\.\d+)?$/.test(rawText.trim())) {
      const declared = Number(rawText.trim());
      if (declared > 0) fps = declared;
      continue;
    }
    const body = rawText.replace(/\{[^}]*\}/g, '').replace(/\|/g, '\n');
    cues.push({ start: Number(startFrame) / fps, end: Number(endFrame) / fps, text: body });
  }
  return cuesToSrt(cues);
}

/** MPL2: `[startTenths][endTenths]text` — the bracketed numbers are tenths of a second, not frames. */
function mpl2ToSrt(text: string): string {
  const cues: Cue[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\[(\d+)\]\[(\d+)\](.*)$/.exec(line.trim());
    if (!match) continue;
    const [, start, end, rawText] = match;
    cues.push({ start: Number(start) / 10, end: Number(end) / 10, text: rawText.replace(/\|/g, '\n').replace(/^\/+/, '') });
  }
  return cuesToSrt(cues);
}

/** SBV (YouTube captions export): `H:MM:SS.mmm,H:MM:SS.mmm`, then text line(s), blocks separated by a blank line. */
function sbvToSrt(text: string): string {
  const timeRe = /^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})\s*,\s*(\d+):(\d{2}):(\d{2})[.,](\d{1,3})/;
  const toSeconds = (h: string, m: string, s: string, ms: string) =>
    Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0').slice(0, 3)) / 1000;
  const cues: Cue[] = [];
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (!lines.length) continue;
    const match = timeRe.exec(lines[0]);
    if (!match) continue;
    const [, h1, m1, s1, ms1, h2, m2, s2, ms2] = match;
    cues.push({ start: toSeconds(h1, m1, s1, ms1), end: toSeconds(h2, m2, s2, ms2), text: lines.slice(1).join('\n') });
  }
  return cuesToSrt(cues);
}

/** TTML/DFXP time expressions: clock-time (`00:00:01.5` or frame form `00:00:01:12`), or offset-time (`1.5s`, `1500ms`, a bare number of seconds). Ticks (`t`) have no fixed duration without a declared tickRate, which this parser does not track, so they resolve to 0 rather than guess. */
function parseTtmlTime(value: string, fps: number): number {
  const v = value.trim();
  const clock = /^(\d{2,}):(\d{2}):(\d{2})(?:[.,](\d+)|:(\d{2,3}))?$/.exec(v);
  if (clock) {
    const [, h, m, s, frac, frames] = clock;
    let seconds = Number(h) * 3600 + Number(m) * 60 + Number(s);
    if (frac) seconds += Number(`0.${frac}`);
    else if (frames) seconds += Number(frames) / fps;
    return seconds;
  }
  const offset = /^([\d.]+)(h|m|ms|f|t|s)?$/.exec(v);
  if (offset) {
    const n = Number(offset[1]);
    switch (offset[2]) {
      case 'h': return n * 3600;
      case 'm': return n * 60;
      case 'ms': return n / 1000;
      case 'f': return n / fps;
      case 't': return 0;
      default: return n; // bare number or trailing "s" both mean seconds
    }
  }
  return 0;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, '&');
}

/** Handles both TTML proper and its older name, DFXP — same schema for the subset used here. */
function ttmlToSrt(xml: string, fps: number): string {
  const cues: Cue[] = [];
  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let match: RegExpExecArray | null;
  while ((match = pRe.exec(xml))) {
    const [, attrs, inner] = match;
    const begin = /\bbegin\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    const end = /\bend\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    const dur = /\bdur\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    if (!begin) continue;
    const start = parseTtmlTime(begin, fps);
    const stop = end ? parseTtmlTime(end, fps) : dur ? start + parseTtmlTime(dur, fps) : start + 2;
    const text = decodeXmlEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
    if (text) cues.push({ start, end: stop, text });
  }
  return cuesToSrt(cues);
}

type ConvertibleFormat = 'microdvd' | 'mpl2' | 'sbv' | 'ttml';

function detectConvertibleFormat(filePath: string, content: string): ConvertibleFormat | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mpl2') return 'mpl2';
  if (ext === '.sbv') return 'sbv';
  if (ext === '.ttml' || ext === '.dfxp') return 'ttml';
  // ".sub" is ambiguous: MicroDVD (plain text, needs conversion) and SubViewer (plain text,
  // already demuxed correctly by FFmpeg's own probing) share the extension. Only the former
  // needs help here; sniff the content rather than trust the extension alone.
  if (ext === '.sub' && looksLikeMicrodvd(content)) return 'microdvd';
  return undefined;
}

/**
 * Converts external subtitle files in formats FFmpeg cannot reliably read on its own into a
 * plain .srt file, and returns its path. Formats FFmpeg already demuxes correctly (.srt, .ass,
 * .ssa, .vtt, .smi, and SubViewer-style .sub) are returned completely untouched — including
 * their original extension, which matters downstream (e.g. keeping .ass/.ssa styling intact, and
 * choosing the right soft-subtitle codec for MKV/MP4/WebM).
 *
 * `fallbackFps` is used only for formats whose own timing is frame-based (MicroDVD, and TTML's
 * rare frame-count time expressions) and that don't declare their own rate; pass the source
 * video's frame rate when known.
 *
 * Never throws: a file that can't be read, or that doesn't actually match its detected format
 * closely enough to yield any cues, is returned unchanged so FFmpeg can report a clear error
 * itself rather than this step failing silently.
 */
export function normalizeSubtitleForFfmpeg(sourcePath: string, fallbackFps = 25, encoding: SubtitleEncoding = 'auto'): { path: string; tempDir?: string } {
  try {
    // Decoded here (not by FFmpeg) so a Windows-1256 / UTF-16 file converts correctly. The .srt
    // written below is always UTF-8, so callers must stop applying the user's encoding choice to it.
    const text = stripBom(decodeSubtitleBytes(fs.readFileSync(sourcePath), encoding).text);
    const format = detectConvertibleFormat(sourcePath, text);
    if (!format) return { path: sourcePath };
    const srt =
      format === 'microdvd' ? microdvdToSrt(text, fallbackFps) :
      format === 'mpl2' ? mpl2ToSrt(text) :
      format === 'sbv' ? sbvToSrt(text) :
      ttmlToSrt(text, fallbackFps);
    if (!srt.trim()) return { path: sourcePath };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozh-subs-'));
    const out = path.join(dir, `${path.basename(sourcePath, path.extname(sourcePath))}.srt`);
    fs.writeFileSync(out, srt, 'utf8');
    return { path: out, tempDir: dir };
  } catch {
    return { path: sourcePath };
  }
}
