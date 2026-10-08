import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildFfmpegArgs, buildPreviewArgs, formatCommand, EncodeConfigError } from './ffmpegArgs';
import { isAbsolutePath, partialPath } from './paths';
import { parseProbe } from './probe';
import { ProgressParser, summarizeFfmpegError } from './progress';
import { parseFrameRate, SUBTITLE_ENCODINGS, subtitleKind } from './rules';
import { normalizeSubtitleForFfmpeg } from './subtitleConvert';
import { parseSrtCues, pickPreviewTime, pngSize } from './subtitlePreview';
import { fixArabicSubtitleText, hasArabicScript, prepareExternalSubtitle } from './subtitleText';
import type { BinaryStatus, EncodeResult, EncodeSettings, FfmpegStatus, MediaInfo, ProgressInfo, SubtitlePreviewResult } from './types';

// ---------------------------------------------------------------------------------------------
// Locating binaries
// ---------------------------------------------------------------------------------------------

const overrides: { ffmpeg?: string; ffprobe?: string } = {};
const bundled: { ffmpeg?: string; ffprobe?: string } = {};
let fallbackFontsDir: string | undefined;

/**
 * Directory of bundled fallback fonts (see bundledFont.ts), set once at startup. It is handed to
 * libass only as an extra place to look for Arabic/Kurdish glyphs; it never selects a font.
 */
export function setFallbackFontsDir(next: string | undefined): void {
  fallbackFontsDir = next;
}

/** Paths chosen by the user (Tools → Locate FFmpeg). Empty values fall back to env vars, then the bundled copy, then PATH. */
export function setBinaryOverrides(next: { ffmpeg?: string; ffprobe?: string }): void {
  overrides.ffmpeg = next.ffmpeg || undefined;
  overrides.ffprobe = next.ffprobe || undefined;
}

/** Paths to the FFmpeg/FFprobe copies Rozh ships with (set once at startup from bundledBinaries.ts). */
export function setBundledBinaries(next: { ffmpeg?: string; ffprobe?: string }): void {
  bundled.ffmpeg = next.ffmpeg || undefined;
  bundled.ffprobe = next.ffprobe || undefined;
}

export function binaryPath(name: 'ffmpeg' | 'ffprobe'): string {
  return overrides[name] || process.env[`${name.toUpperCase()}_PATH`] || bundled[name] || name;
}

// ---------------------------------------------------------------------------------------------
// Small process helper (argument arrays only, never a shell)
// ---------------------------------------------------------------------------------------------

interface RunResult { stdout: string; stderr: string; code: number | null }

function run(command: string, args: string[], timeoutMs = 30_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    // setEncoding uses a streaming decoder, so multi-byte characters (Kurdish/Arabic tags) split across chunks stay intact.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${command} did not respond within ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    child.once('error', error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); });
    child.once('close', code => { if (settled) return; settled = true; clearTimeout(timer); resolve({ stdout, stderr, code }); });
  });
}

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

async function probeBinary(name: 'ffmpeg' | 'ffprobe'): Promise<BinaryStatus> {
  const path = binaryPath(name);
  try {
    const result = await run(path, ['-version'], 15_000);
    if (result.code !== 0) return { found: false, version: '', path, error: `exited with code ${result.code}` };
    return { found: true, version: (result.stdout.split(/\r?\n/)[0] ?? '').trim(), path };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { found: false, version: '', path, error: code === 'ENOENT' ? 'not found' : error instanceof Error ? error.message : String(error) };
  }
}

export function parseEncoderList(output: string): string[] {
  return [...output.matchAll(/^\s*[VASN.][A-Za-z.]{5}\s+(\S+)/gm)].map(m => m[1]).filter(name => name !== '=');
}

export async function detectFfmpeg(): Promise<FfmpegStatus> {
  const [ffmpeg, ffprobe] = await Promise.all([probeBinary('ffmpeg'), probeBinary('ffprobe')]);
  let encoders: string[] = [];
  if (ffmpeg.found) {
    try {
      const listed = await run(binaryPath('ffmpeg'), ['-hide_banner', '-encoders'], 20_000);
      if (listed.code === 0) encoders = parseEncoderList(listed.stdout);
    } catch { /* leave encoders empty; availability is still reported honestly below */ }
  }
  const hardware = encoders.filter(name => /_(nvenc|qsv|amf|videotoolbox|vaapi|mf|v4l2m2m)$/i.test(name));

  let problem: string | undefined;
  if (!ffmpeg.found && !ffprobe.found) problem = 'FFmpeg and FFprobe were not found.';
  else if (!ffmpeg.found) problem = `FFmpeg was not found (${ffmpeg.error}).`;
  else if (!ffprobe.found) problem = `FFprobe was not found (${ffprobe.error}). It normally ships in the same folder as FFmpeg.`;
  else if (!encoders.length) problem = 'FFmpeg runs but reported no encoders. This build may be broken.';

  return { available: ffmpeg.found && ffprobe.found && encoders.length > 0, ffmpeg, ffprobe, encoders, hardware, problem };
}

// ---------------------------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------------------------

export async function inspectMedia(filePath: string): Promise<MediaInfo> {
  if (!isAbsolutePath(filePath)) throw new Error('The file path must be absolute.');
  let size = 0;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    throw new Error('The selected file no longer exists or cannot be read.');
  }

  let result: RunResult;
  try {
    result = await run(binaryPath('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', '-i', filePath], 60_000);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('FFprobe was not found. The copy Rozh ships with may be missing for this platform — use Tools → Locate FFmpeg to point at one.');
    throw new Error(`FFprobe could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.code !== 0) throw new Error(summarizeFfmpegError(result.stderr, result.code).summary);

  let raw: unknown;
  try { raw = JSON.parse(result.stdout); } catch { throw new Error('FFprobe returned output that could not be understood.'); }
  return parseProbe(raw, filePath, size);
}

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

/** Keeps the start of the log (the command) and the most recent output, so huge encodes cannot exhaust memory. */
export class LogBuffer {
  private head = '';
  private tailText = '';
  private dropped = false;
  constructor(private readonly headLimit = 32_000, private readonly tailLimit = 512_000) {}

  append(text: string): void {
    if (this.head.length < this.headLimit) {
      const room = this.headLimit - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
    }
    if (!text) return;
    this.tailText += text;
    if (this.tailText.length > this.tailLimit) {
      this.tailText = this.tailText.slice(this.tailText.length - this.tailLimit);
      this.dropped = true;
    }
  }

  toString(): string {
    return this.dropped ? `${this.head}\n[… log truncated …]\n${this.tailText}` : this.head + this.tailText;
  }

  tail(chars: number): string {
    const all = this.head + this.tailText;
    return all.length > chars ? all.slice(all.length - chars) : all;
  }
}

export type EncodeOutcome = EncodeResult & { log: string; command: string };

export interface EncodeController {
  args: string[];
  command: string;
  /** Requests a graceful stop ('q'), then terminates the process if it does not exit. Safe to call at any time. */
  cancel(): void;
  done: Promise<EncodeOutcome>;
}

const GRACEFUL_STOP_MS = 4_000;
const FORCE_KILL_MS = 8_000;

async function removeQuietly(file: string): Promise<void> {
  try { await fs.rm(file, { force: true }); } catch { /* best effort */ }
}

const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i;

/** Converts any text subtitle file FFmpeg can read (WebVTT, SAMI, SubViewer…) into ASS text, or undefined on failure. */
function convertToAssText(input: string, extraArgs: string[] = []): string | undefined {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'rozh-conv-'));
    const out = path.join(dir, 'converted.ass');
    const result = spawnSync(binaryPath('ffmpeg'), ['-v', 'error', '-y', ...extraArgs, '-i', input, ...(extraArgs.length ? [] : ['-map', '0:s:0']), '-c:s', 'ass', out], {
      encoding: 'utf8', timeout: 20_000, windowsHide: true
    });
    return result.status === 0 && existsSync(out) ? readFileSync(out, 'utf8') : undefined;
  } catch {
    return undefined;
  } finally {
    if (dir) void removeQuietly(dir);
  }
}

/**
 * Builds a directory libass can use as `fontsdir`: the bundled fallback fonts, plus (optionally)
 * the fonts attached inside a Matroska file — an embedded ASS track's own fonts have to travel
 * with it once the track is burned from a temp file instead of straight out of the container.
 */
function buildFontsDir(parent: string, attachmentsFrom?: string): string | undefined {
  try {
    const dir = path.join(parent, 'fonts');
    mkdirSync(dir, { recursive: true });
    if (fallbackFontsDir && existsSync(fallbackFontsDir)) {
      for (const name of readdirSync(fallbackFontsDir)) if (FONT_FILE.test(name)) copyFileSync(path.join(fallbackFontsDir, name), path.join(dir, name));
    }
    if (attachmentsFrom) {
      // Explicit per-attachment output names: never trust the filename stored inside the container.
      const dump: string[] = [];
      for (let i = 0; i < 24; i++) dump.push(`-dump_attachment:t:${i}`, path.join(dir, `attached-${i}.ttf`));
      spawnSync(binaryPath('ffmpeg'), ['-v', 'quiet', '-y', ...dump, '-i', attachmentsFrom], { timeout: 20_000, windowsHide: true });
    }
    return readdirSync(dir).length ? dir : undefined;
  } catch {
    return undefined;
  }
}

interface EmbeddedBurnSource { file: string; fontsDir?: string; tempDir: string }

/**
 * For an embedded text track: extracts it to ASS and, only if it turns out to be Arabic-script,
 * applies the same repairs as for external files (see subtitleText.ts). Returns undefined for
 * non-Arabic tracks (burned straight from the container, exactly as before) and on any failure.
 * Extraction only demuxes the one subtitle stream, so even a long file resolves in well under a second.
 */
function prepareEmbeddedArabicSubtitle(input: string, absoluteStreamIndex: number): EmbeddedBurnSource | undefined {
  let tempDir: string | undefined;
  try {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'rozh-subs-'));
    const extracted = path.join(tempDir, 'track.ass');
    const result = spawnSync(binaryPath('ffmpeg'), ['-v', 'error', '-y', '-i', input, '-map', `0:${absoluteStreamIndex}`, '-c:s', 'ass', extracted], {
      encoding: 'utf8', timeout: 20_000, windowsHide: true
    });
    if (result.status !== 0 || !existsSync(extracted)) throw new Error('extraction failed');
    const text = readFileSync(extracted, 'utf8');
    if (!hasArabicScript(text)) throw new Error('not arabic');
    writeFileSync(extracted, fixArabicSubtitleText(text, 'ass'), 'utf8');
    return { file: extracted, fontsDir: buildFontsDir(tempDir, input), tempDir };
  } catch {
    if (tempDir) void removeQuietly(tempDir);
    return undefined;
  }
}

export interface PreparedSettings {
  /** Settings to hand to buildFfmpegArgs: subtitle paths/encoding already normalised and repaired. */
  settings: EncodeSettings;
  /** Extra directory libass should search for fonts (bundled fallback and/or fonts attached to the video). */
  fontsDir?: string;
  /** Temp directories created while preparing; the caller must delete them when finished. */
  tempDirs: string[];
}

/**
 * Everything that has to happen to a subtitle before FFmpeg can burn it in correctly: format
 * conversion, encoding detection, Arabic/Kurdish repairs and the fallback font directory.
 * Used by BOTH the real encode and the subtitle preview, so the preview is drawn from exactly
 * the same prepared file with exactly the same fonts.
 */
export function prepareSettingsForFfmpeg(settings: EncodeSettings, media: MediaInfo): PreparedSettings {
  const tempSubtitleDirs: string[] = [];
  let effectiveSettings = settings;
  const { subtitles, subtitleEncoding } = settings;

  // Formats FFmpeg has no demuxer for, or reliably misdetects (see subtitleConvert.ts), are
  // converted to plain .srt up front, before anything below touches the file — everything past
  // this point only ever has to deal with formats FFmpeg already understands natively.
  const externalSubtitleFile = subtitles.mode === 'burn' && subtitles.source?.kind === 'external' ? subtitles.source.file
    : subtitles.mode === 'keep' ? subtitles.external
    : undefined;
  if (externalSubtitleFile) {
    const fallbackFps = parseFrameRate(media.video?.r_frame_rate) ?? parseFrameRate(media.video?.avg_frame_rate) ?? 25;
    const normalized = normalizeSubtitleForFfmpeg(externalSubtitleFile, fallbackFps, subtitleEncoding);
    if (normalized.path !== externalSubtitleFile) {
      if (normalized.tempDir) tempSubtitleDirs.push(normalized.tempDir);
      effectiveSettings = subtitles.mode === 'burn' && subtitles.source?.kind === 'external'
        ? { ...effectiveSettings, subtitles: { ...subtitles, source: { ...subtitles.source, file: normalized.path } } }
        : { ...effectiveSettings, subtitles: { ...(subtitles as { mode: 'keep'; embedded: number[]; external?: string }), external: normalized.path } };
    }
  }

  // Anything we converted ourselves is already UTF-8, so the user's "subtitle encoding" choice
  // (which tells FFmpeg to run iconv) must no longer be applied to it.
  let encodingForFfmpeg = subtitleEncoding;
  if (effectiveSettings !== settings) encodingForFfmpeg = 'auto';

  // Burn-in only: repair Arabic/Sorani-Kurdish text encoding and glyphs, and fix mixed-direction
  // text that does not start with Arabic. ASS layout and font choices stay authored (see subtitleText.ts).
  // NO font is ever chosen or changed here: libass resolves whatever font the subtitle names against the user's own fonts.
  // The bundled font directory is only passed along as an extra place to find missing glyphs.
  let fontsDirOverride: string | undefined;
  const burning = effectiveSettings.subtitles;
  if (burning.mode === 'burn' && burning.source) {
    const source = burning.source;
    if (source.kind === 'external') {
      const prepared = prepareExternalSubtitle(source.file, encodingForFfmpeg);
      let file = prepared.path;
      if (prepared.tempDir) tempSubtitleDirs.push(prepared.tempDir);
      if (prepared.path !== source.file) encodingForFfmpeg = 'auto';
      if (prepared.arabic) {
        if (prepared.format === 'other') {
          // WebVTT / SAMI / SubViewer: let FFmpeg turn it into ASS first, then repair that.
          const ass = convertToAssText(prepared.path);
          if (ass !== undefined) {
            const dir = mkdtempSync(path.join(os.tmpdir(), 'rozh-subs-'));
            tempSubtitleDirs.push(dir);
            file = path.join(dir, `${path.basename(source.file, path.extname(source.file))}.ass`);
            writeFileSync(file, fixArabicSubtitleText(ass, 'ass'), 'utf8');
          }
        }
        if (fallbackFontsDir && existsSync(fallbackFontsDir)) fontsDirOverride = fallbackFontsDir;
      }
      if (file !== source.file) {
        effectiveSettings = { ...effectiveSettings, subtitles: { ...burning, source: { kind: 'external', file } } };
      }
    } else {
      const stream = media.subtitles.find(s => s.index === source.streamIndex);
      if (stream && subtitleKind(stream.codec_name) === 'text') {
        const embedded = prepareEmbeddedArabicSubtitle(settings.input, stream.index);
        if (embedded) {
          tempSubtitleDirs.push(embedded.tempDir);
          fontsDirOverride = embedded.fontsDir;
          effectiveSettings = { ...effectiveSettings, subtitles: { ...burning, source: { kind: 'external', file: embedded.file } } };
        }
      }
    }
  }
  if (encodingForFfmpeg !== effectiveSettings.subtitleEncoding) effectiveSettings = { ...effectiveSettings, subtitleEncoding: encodingForFfmpeg };
  return { settings: effectiveSettings, fontsDir: fontsDirOverride, tempDirs: tempSubtitleDirs };
}

export function startEncoding(settings: EncodeSettings, media: MediaInfo, onProgress: (info: ProgressInfo) => void): EncodeController {
  const finalOutput = settings.output;
  const partial = partialPath(finalOutput);
  const executable = binaryPath('ffmpeg');

  const prepared = prepareSettingsForFfmpeg(settings, media);
  const tempSubtitleDirs = prepared.tempDirs;
  const effectiveSettings = prepared.settings;
  const fontsDirOverride = prepared.fontsDir;

  // Encode into a temporary sibling file. The real output only appears once FFmpeg has finished successfully,
  // so a cancel, crash or power cut can never leave a truncated file (or destroy an existing one).
  let args: string[];
  try {
    args = buildFfmpegArgs({ ...effectiveSettings, output: partial, overwrite: true }, media, fontsDirOverride ? { dir: fontsDirOverride } : undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { args: [], command: '', cancel() { /* nothing was started */ }, done: Promise.resolve({ status: 'failed', error: message, log: message, command: '' }) };
  }
  const command = formatCommand(executable, args);
  const log = new LogBuffer();
  log.append(`$ ${command}\n\n`);

  let cancelRequested = false;
  let child: ChildProcessWithoutNullStreams | undefined;
  let exited = false;
  const timers: NodeJS.Timeout[] = [];

  const outcome = (result: EncodeResult): EncodeOutcome => ({ ...result, log: log.toString(), command });

  const done = (async (): Promise<EncodeOutcome> => {
    if (!settings.overwrite && existsSync(finalOutput)) {
      return outcome({ status: 'failed', error: `The output file already exists and will not be replaced: ${finalOutput}` });
    }
    if (cancelRequested) return outcome({ status: 'cancelled' });

    return new Promise<EncodeOutcome>(resolve => {
      let settled = false;
      const settle = (result: EncodeOutcome) => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        resolve(result);
      };

      try {
        child = spawn(executable, args, { windowsHide: true });
      } catch (error) {
        settle(outcome({ status: 'failed', error: `FFmpeg could not be started: ${error instanceof Error ? error.message : String(error)}` }));
        return;
      }
      const proc = child;
      proc.stdin.on('error', () => { /* the process may already have exited when we write 'q' */ });
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');

      const parser = new ProgressParser(media.duration, onProgress);
      proc.stdout.on('data', (chunk: string) => parser.push(chunk));
      proc.stderr.on('data', (chunk: string) => log.append(chunk));

      proc.once('error', error => {
        exited = true;
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        void removeQuietly(partial);
        settle(outcome({ status: 'failed', error: missing ? 'FFmpeg was not found. The copy Rozh ships with may be missing for this platform — use Tools → Locate FFmpeg to point at one.' : `FFmpeg could not be started: ${error.message}` }));
      });

      proc.once('close', async (code, signal) => {
        exited = true;
        if (settled) return;
        if (cancelRequested) {
          await removeQuietly(partial);
          settle(outcome({ status: 'cancelled' }));
          return;
        }
        if (code === 0) {
          if (!existsSync(partial)) {
            settle(outcome({ status: 'failed', error: 'FFmpeg reported success but produced no output file.' }));
            return;
          }
          if (!settings.overwrite && existsSync(finalOutput)) {
            settle(outcome({ status: 'failed', error: `A file appeared at the output path while encoding, so it was not replaced. The finished video was kept at: ${partial}` }));
            return;
          }
          try {
            await fs.rename(partial, finalOutput);
            settle(outcome({ status: 'complete', output: finalOutput }));
          } catch (error) {
            settle(outcome({ status: 'failed', error: `Encoding finished but the file could not be moved into place (${error instanceof Error ? error.message : String(error)}). The video was kept at: ${partial}` }));
          }
          return;
        }
        await removeQuietly(partial);
        if (signal) {
          settle(outcome({ status: 'failed', error: `FFmpeg was terminated unexpectedly (${signal}).`, detail: log.tail(4000) }));
          return;
        }
        const { summary, detail } = summarizeFfmpegError(log.tail(60_000), code);
        settle(outcome({ status: 'failed', error: summary, detail }));
      });
    });
  })().catch((error): EncodeOutcome => {
    const message = error instanceof EncodeConfigError || error instanceof Error ? error.message : String(error);
    return outcome({ status: 'failed', error: message });
  }).finally(() => {
    // Whatever happened, any temp subtitle copies made along the way (format conversion,
    // ligature normalization) are no longer needed.
    for (const dir of tempSubtitleDirs) void fs.rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ });
  });

  return {
    args,
    command,
    done,
    cancel() {
      if (cancelRequested) return;
      cancelRequested = true;
      if (!child || exited) return;
      const proc = child;
      try { proc.stdin.write('q\n'); } catch { /* fall through to the timers */ }
      timers.push(setTimeout(() => { if (!exited) proc.kill('SIGTERM'); }, GRACEFUL_STOP_MS));
      timers.push(setTimeout(() => { if (!exited) proc.kill('SIGKILL'); }, FORCE_KILL_MS));
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Subtitle preview frame
// ---------------------------------------------------------------------------------------------

const PREVIEW_TIMEOUT_MS = 30_000;

/** Subtitle cues of whatever is about to be burned in, read by letting FFmpeg convert it to SRT on stdout. Empty on any failure (e.g. bitmap tracks). */
async function readBurnCues(settings: EncodeSettings): Promise<ReturnType<typeof parseSrtCues>> {
  const source = settings.subtitles.mode === 'burn' ? settings.subtitles.source : undefined;
  if (!source) return [];
  const iconv = SUBTITLE_ENCODINGS[settings.subtitleEncoding]?.iconv;
  const args = source.kind === 'external'
    ? ['-v', 'error', ...(iconv ? ['-sub_charenc', iconv] : []), '-i', source.file, '-map', '0:s:0', '-f', 'srt', '-']
    : ['-v', 'error', '-i', settings.input, '-map', `0:${source.streamIndex}`, '-f', 'srt', '-'];
  try {
    const result = await run(binaryPath('ffmpeg'), args, 20_000);
    return result.code === 0 ? parseSrtCues(result.stdout) : [];
  } catch {
    return [];
  }
}

/**
 * Renders a single frame with the subtitle burned in, using the same preparation and filters as a
 * real encode. Without `atSec` it picks the most demanding subtitle line (longest, most lines) inside
 * the trim range, because that is the one most likely to expose wrapping or font problems.
 */
export async function renderSubtitlePreview(settings: EncodeSettings, atSec?: number): Promise<SubtitlePreviewResult> {
  const tempDirs: string[] = [];
  try {
    if (settings.subtitles.mode !== 'burn') return { status: 'failed', error: 'Subtitles are not set to burn into the video.' };
    if (!settings.subtitles.source) return { status: 'failed', error: 'There is no subtitle to burn in. Choose an external file or an embedded track.' };

    const media = await inspectMedia(settings.input);
    if (!media.video) return { status: 'failed', error: 'This file has no video picture to preview.' };

    const prepared = prepareSettingsForFfmpeg(settings, media);
    tempDirs.push(...prepared.tempDirs);

    const cues = atSec === undefined ? await readBurnCues(prepared.settings) : [];
    const pick = pickPreviewTime({
      cues, requestedSec: atSec, trimStartSec: settings.trim?.startSec, trimEndSec: settings.trim?.endSec, durationSec: media.duration
    });

    const workDir = mkdtempSync(path.join(os.tmpdir(), 'rozh-preview-'));
    tempDirs.push(workDir);
    const frame = path.join(workDir, 'frame.png');
    // Encoding settings that don't matter for one picture are left out inside buildPreviewArgs.
    const args = buildPreviewArgs(prepared.settings, media, pick.timeSec, frame, prepared.fontsDir ? { dir: prepared.fontsDir } : undefined);

    const result = await run(binaryPath('ffmpeg'), args, PREVIEW_TIMEOUT_MS);
    if (result.code !== 0) {
      const { summary } = summarizeFfmpegError(result.stderr, result.code);
      return { status: 'failed', error: summary };
    }
    if (!existsSync(frame)) {
      return { status: 'failed', error: 'FFmpeg finished but did not produce a picture. The chosen time may be past the end of the video.' };
    }
    const bytes = readFileSync(frame);
    const size = pngSize(bytes);
    return { status: 'ok', png: bytes.toString('base64'), timeSec: pick.timeSec, how: pick.how, width: size?.width, height: size?.height };
  } catch (error) {
    const message = error instanceof EncodeConfigError || error instanceof Error ? error.message : String(error);
    return { status: 'failed', error: message };
  } finally {
    for (const dir of tempDirs) void fs.rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ });
  }
}
