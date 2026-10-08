// Pure helpers for the "Preview subtitle frame" feature. No Electron, no child processes.

export interface PreviewCue { start: number; end: number; text: string }

const TIME = /(\d+):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[.,](\d{1,3})/;

const seconds = (h: string, m: string, s: string, ms: string): number =>
  Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;

/** Text as the viewer sees it: ASS override blocks, HTML-ish tags and ASS line breaks removed. */
export function visibleText(raw: string): string {
  return raw
    .replace(/\{[^}]*\}/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\\[Nn]/g, '\n')
    .trim();
}

/** Reads the cues out of SRT text (what FFmpeg prints when asked to convert any text subtitle to `-f srt`). */
export function parseSrtCues(srt: string): PreviewCue[] {
  const cues: PreviewCue[] = [];
  for (const block of srt.replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const at = lines.findIndex(line => TIME.test(line));
    if (at < 0) continue;
    const m = TIME.exec(lines[at])!;
    const text = visibleText(lines.slice(at + 1).join('\n'));
    if (!text) continue;
    cues.push({ start: seconds(m[1], m[2], m[3], m[4]), end: seconds(m[5], m[6], m[7], m[8]), text });
  }
  return cues;
}

/** How "hard" a cue is to lay out: the longest line matters most for wrapping, the line count for vertical room. */
export function cueDifficulty(text: string): number {
  const lines = text.split('\n');
  const longest = Math.max(...lines.map(l => [...l].length));
  return longest * 10 + lines.length * 5 + [...text].length;
}

export interface PreviewPick { timeSec: number; how: 'requested' | 'longest-line' | 'fallback' }

/**
 * Chooses the position (seconds in the source) to render.
 * - A time the user asked for always wins (clamped into the file).
 * - Otherwise the most demanding cue inside the trim range, sampled at its middle so the cue is
 *   certainly on screen even if the subtitle timing is a little off.
 * - Otherwise a fallback near the start of the encoded range (e.g. bitmap tracks have no readable text).
 */
export function pickPreviewTime(options: {
  cues: PreviewCue[];
  requestedSec?: number;
  trimStartSec?: number;
  trimEndSec?: number;
  durationSec?: number;
}): PreviewPick {
  const { cues, requestedSec, trimStartSec, trimEndSec, durationSec } = options;
  const lastSecond = durationSec !== undefined ? Math.max(0, durationSec - 0.1) : undefined;
  const clamp = (t: number) => Math.max(0, lastSecond !== undefined ? Math.min(lastSecond, t) : t);

  if (requestedSec !== undefined && Number.isFinite(requestedSec)) return { timeSec: clamp(requestedSec), how: 'requested' };

  const from = trimStartSec ?? 0;
  const to = trimEndSec ?? Infinity;
  const candidates = cues.filter(c => c.end > from && c.start < to && c.end - c.start >= 0.3);
  let best: PreviewCue | undefined;
  for (const cue of candidates) if (!best || cueDifficulty(cue.text) > cueDifficulty(best.text)) best = cue;
  if (best) {
    const start = Math.max(best.start, from);
    const end = Math.min(best.end, to);
    return { timeSec: clamp(start + (end - start) / 2), how: 'longest-line' };
  }
  return { timeSec: clamp(from + 1), how: 'fallback' };
}

/** Width and height of a PNG, read from its IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
