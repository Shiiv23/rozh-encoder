// Builds FFmpeg command lines as argument ARRAYS. Nothing here ever creates a shell string,
// so file names with spaces, quotes, Kurdish/Arabic letters, etc. are passed through untouched.

import { isAbsolutePath, isWindowsPath } from './paths';
import { codecOfEncoder, computeScaleTarget, crfFor, DEFAULT_AUDIO_KBPS, hardwareEncoderName, SUBTITLE_ENCODINGS, subtitleKind, videoBitDepth } from './rules';
import type { EncodeSettings, HwBackend, MediaInfo, SpeedPreset, VideoEncoder, WatermarkPosition, WatermarkSettings } from './types';

export class EncodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodeConfigError';
  }
}

/**
 * Quotes a value for use inside an FFmpeg filtergraph option, e.g. `subtitles=filename=<value>`.
 * FFmpeg parses filter arguments in two passes, so a colon needs one backslash *inside* single quotes
 * and a literal single quote needs the sequence  '\\\'  (close quote, escaped backslash, escaped quote, reopen).
 * Windows paths have their backslashes turned into forward slashes, which FFmpeg accepts everywhere.
 */
export function escapeFilterValue(value: string): string {
  const escaped = (isWindowsPath(value) ? value.replace(/\\/g, '/') : value.replace(/\\/g, '\\\\'))
    .replace(/:/g, '\\:')
    .replace(/'/g, "'\\\\\\''");
  return `'${escaped}'`;
}

/**
 * Gives libass one extra directory of fonts to search, used purely as a safety net: it is where
 * a glyph can still be found when neither the font a subtitle asks for nor anything on the
 * user's system has the Arabic/Kurdish letters. It never changes WHICH font a subtitle uses —
 * Rozh does not pass `FontName` (or any other style override) to libass, so an .ass/.ssa Style,
 * an inline \fn tag or an SRT <font face> keeps resolving against the fonts installed on the
 * user's own device, exactly as the file's author wrote it.
 */
export interface ArabicFontOverride { dir: string }

function subtitlesFilter(file: string, iconv?: string, streamOrdinal?: number, arabicFont?: ArabicFontOverride): string {
  const parts = [`filename=${escapeFilterValue(file)}`];
  if (iconv) parts.push(`charenc=${iconv}`);
  if (streamOrdinal !== undefined) parts.push(`si=${streamOrdinal}`);
  if (arabicFont) parts.push(`fontsdir=${escapeFilterValue(arabicFont.dir)}`);
  return `subtitles=${parts.join(':')}`;
}

/** Renders seconds as an FFmpeg `-ss`/`-t` argument. Millisecond precision avoids drift on repeated math. */
function formatSeekSeconds(seconds: number): string {
  return seconds.toFixed(3);
}

const DEEP_COLOR_ENCODERS: VideoEncoder[] = ['libx265', 'libsvtav1', 'libaom-av1', 'libvpx-vp9'];

function speedArgs(encoder: VideoEncoder, speed: SpeedPreset): string[] {
  switch (encoder) {
    case 'libx264':
    case 'libx265':
      return ['-preset', { fast: 'fast', balanced: 'medium', slow: 'slow' }[speed]];
    case 'libsvtav1':
      // SVT-AV1 takes a number, not a name. Lower is slower.
      return ['-preset', { fast: '10', balanced: '8', slow: '5' }[speed]];
    case 'libaom-av1':
      return ['-cpu-used', { fast: '7', balanced: '6', slow: '4' }[speed], '-row-mt', '1'];
    case 'libvpx-vp9':
      return ['-deadline', 'good', '-cpu-used', { fast: '4', balanced: '2', slow: '1' }[speed], '-row-mt', '1'];
  }
}

/**
 * Arguments for a hardware encoder. Quality is expressed on each vendor's own constant-quality scale,
 * derived from the software CRF so the Quality presets keep roughly the same meaning.
 */
function hardwareCodecArgs(backend: HwBackend, settings: EncodeSettings, media?: MediaInfo): string[] {
  const codec = codecOfEncoder(settings.videoEncoder);
  const name = hardwareEncoderName(backend, codec);
  if (!name) throw new EncodeConfigError(`The ${backend} hardware encoder cannot produce ${codec}.`);
  // Hardware rate control scales top out at 51; clamp the software CRF into that range.
  const q = Math.min(51, Math.max(1, crfFor(settings.videoEncoder, settings.quality, settings.customCrf)));
  const deep = codec !== 'h264' && videoBitDepth(media?.video) >= 10;
  const args = ['-c:v', name];
  switch (backend) {
    case 'nvenc':
      args.push('-preset', { fast: 'p3', balanced: 'p5', slow: 'p7' }[settings.speed], '-tune', 'hq',
        '-rc', 'vbr', '-cq', String(q), '-b:v', '0');
      args.push('-pix_fmt', deep ? 'p010le' : 'yuv420p');
      break;
    case 'qsv':
      args.push('-preset', { fast: 'veryfast', balanced: 'medium', slow: 'veryslow' }[settings.speed], '-global_quality', String(q));
      args.push('-pix_fmt', deep ? 'p010le' : 'nv12');
      break;
    case 'amf':
      args.push('-quality', { fast: 'speed', balanced: 'balanced', slow: 'quality' }[settings.speed],
        '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(Math.min(51, q + 2)));
      if (codec !== 'av1') args.push('-qp_b', String(Math.min(51, q + 4)));
      args.push('-pix_fmt', deep ? 'p010le' : 'nv12');
      break;
    case 'videotoolbox': {
      // VideoToolbox uses -q:v 1-100 where higher is better.
      const vtq = Math.round(Math.min(100, Math.max(1, 100 - q * 1.6)));
      args.push('-q:v', String(vtq), '-allow_sw', '0');
      if (settings.speed === 'fast') args.push('-prio_speed', '1');
      args.push('-pix_fmt', deep ? 'p010le' : 'yuv420p');
      break;
    }
  }
  if (codec === 'h265' && settings.container === 'mp4') args.push('-tag:v', 'hvc1');
  return args;
}

function videoCodecArgs(settings: EncodeSettings, media?: MediaInfo): string[] {
  if (settings.hardware) return hardwareCodecArgs(settings.hardware, settings, media);
  const encoder = settings.videoEncoder;
  const crf = String(crfFor(encoder, settings.quality, settings.customCrf));
  const args = ['-c:v', encoder, '-crf', crf];
  // libaom and libvpx treat -crf as a *cap* unless the target bitrate is explicitly zero.
  if (encoder === 'libaom-av1' || encoder === 'libvpx-vp9') args.push('-b:v', '0');
  args.push(...speedArgs(encoder, settings.speed));
  if (encoder === 'libx265') args.push('-x265-params', 'log-level=error');
  // Keep 10-bit only where the encoder/container combination handles it well; otherwise use universally playable 8-bit 4:2:0.
  const keepDeep = DEEP_COLOR_ENCODERS.includes(encoder) && videoBitDepth(media?.video) >= 10;
  args.push('-pix_fmt', keepDeep ? 'yuv420p10le' : 'yuv420p');
  if (encoder === 'libx265' && settings.container === 'mp4') args.push('-tag:v', 'hvc1'); // required for Apple players
  return args;
}

function audioCodecArgs(settings: EncodeSettings, media?: MediaInfo): string[] {
  if (settings.audioMode === 'copy') return ['-c:a', 'copy'];
  const base = settings.audioBitrateKbps ?? DEFAULT_AUDIO_KBPS[settings.audioMode];
  const codec = settings.audioMode === 'aac' ? ['-c:a', 'aac'] : ['-c:a', 'libopus', '-vbr', 'on'];
  // Multichannel tracks get double the stereo bitrate.
  const rates = media?.audio.length
    ? media.audio.flatMap((track, i) => [`-b:a:${i}`, `${base * ((track.channels ?? 2) > 2 ? 2 : 1)}k`])
    : ['-b:a', `${base}k`];
  return [...codec, ...rates];
}

const OVERLAY_XY: Record<WatermarkPosition, [string, string]> = {
  'top-left': ['M', 'M'], 'top-center': ['(W-w)/2', 'M'], 'top-right': ['W-w-M', 'M'],
  'center-left': ['M', '(H-h)/2'], center: ['(W-w)/2', '(H-h)/2'], 'center-right': ['W-w-M', '(H-h)/2'],
  'bottom-left': ['M', 'H-h-M'], 'bottom-center': ['(W-w)/2', 'H-h-M'], 'bottom-right': ['W-w-M', 'H-h-M']
};

/** Output picture size after the optional downscale, used to size the logo in pixels. */
function outputSize(settings: EncodeSettings, media?: MediaInfo): { width: number; height: number } {
  if (!media?.displayWidth || !media.displayHeight) throw new EncodeConfigError('The watermark needs the source resolution; inspect the file first.');
  const target = settings.shortEdge ? computeScaleTarget(media.displayWidth, media.displayHeight, settings.shortEdge) : undefined;
  return target ?? { width: media.displayWidth, height: media.displayHeight };
}

/** Filter fragment that turns input `[logoLabel]` + `[base]` into `[out]`. */
export function watermarkGraph(wm: WatermarkSettings, logoInput: number, base: string, out: string, size: { width: number; height: number }): string {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
  // Even widths keep chroma subsampling happy.
  const logoW = Math.max(2, Math.round((size.width * clamp(wm.sizePct, 1, 100)) / 200) * 2);
  const margin = Math.round((Math.min(size.width, size.height) * clamp(wm.marginPct, 0, 25)) / 100);
  const alpha = (clamp(wm.opacityPct, 0, 100) / 100).toFixed(3);
  const [x, y] = OVERLAY_XY[wm.position].map(e => e.replace(/M/g, String(margin)));
  return `[${logoInput}:v]scale=${logoW}:-2:flags=lanczos,format=rgba,colorchannelmixer=aa=${alpha}[rozh_wm];` +
    `[${base}][rozh_wm]overlay=x=${x}:y=${y}:format=auto:shortest=1[${out}]`;
}

function externalSubtitleCodec(container: EncodeSettings['container'], file: string): string {
  if (container === 'mp4') return 'mov_text';
  if (container === 'webm') return 'webvtt';
  return /\.(ass|ssa)$/i.test(file) ? 'ass' : 'srt';
}

/** The video part of a command: either a simple `-vf` chain, or a complex graph ending in `[rozh_base]`. */
interface VideoGraph {
  /** Complex graph producing `[rozh_base]` (only for bitmap subtitle overlays). */
  graph?: string;
  /** Simple filter chain applied to the mapped input. */
  simple?: string;
  /** Stream specifier of the picture being filtered, e.g. `0:0`. */
  videoSpecifier: string;
}

/**
 * Scaling, frame-rate and subtitle burn-in filters. Shared by the real encode and the subtitle
 * preview frame so the preview is guaranteed to be drawn by exactly the same filters.
 */
function buildVideoGraph(settings: EncodeSettings, media: MediaInfo | undefined, iconv: string | undefined, arabicFont: ArabicFontOverride | undefined, trimStart: number | undefined): VideoGraph {
  const subtitles = settings.subtitles;
  // Input-side -ss restarts the picture's timestamps at 0, but a text subtitle's cues keep their
  // original times, so a burned-in subtitle would appear `trimStart` seconds late (or never, in a
  // short clip). Shifting the clock forward just for the subtitles filter and back afterwards keeps them in sync.
  const withSubtitleClock = (filter: string): string[] =>
    trimStart ? [`setpts=PTS+${formatSeekSeconds(trimStart)}/TB`, filter, `setpts=PTS-${formatSeekSeconds(trimStart)}/TB`] : [filter];

  // ----- video path -----
  const video = media?.video;
  const videoSpecifier = video ? `0:${video.index}` : '0:v:0';
  let scale: string | undefined;
  if (settings.shortEdge) {
    if (!media?.displayWidth || !media.displayHeight) throw new EncodeConfigError('Scaling needs the source resolution; inspect the file first.');
    const target = computeScaleTarget(media.displayWidth, media.displayHeight, settings.shortEdge);
    if (target) scale = `scale=${target.width}:${target.height}:flags=lanczos`;
  }
  const fps = settings.fps ? `fps=${settings.fps}` : undefined;
  const chain = [fps, scale].filter((f): f is string => Boolean(f));

  // Everything is expressed as a filter_complex graph ending in [rozh_v] when a watermark is used;
  // otherwise the original simple -vf form is kept.
  let graph: string | undefined; // complex graph producing [rozh_base]
  let simple: string | undefined; // simple chain applied to the mapped input

  if (subtitles.mode === 'burn') {
    const source = subtitles.source;
    if (!source) throw new EncodeConfigError('There is no subtitle to burn in.');
    if (source.kind === 'external') {
      chain.push(...withSubtitleClock(subtitlesFilter(source.file, iconv, undefined, arabicFont)));
      simple = chain.join(',');
    } else {
      const stream = media?.subtitles.find(s => s.index === source.streamIndex);
      if (!media || !stream) throw new EncodeConfigError(`Embedded subtitle track #${source.streamIndex} was not found.`);
      const kind = subtitleKind(stream.codec_name);
      if (kind === 'text') {
        // Render after scaling so glyphs are drawn crisply at the output size. `si` counts subtitle streams only.
        chain.push(...withSubtitleClock(subtitlesFilter(settings.input, undefined, media.subtitles.indexOf(stream), arabicFont)));
        simple = chain.join(',');
      } else if (kind === 'bitmap') {
        // PGS / VobSub are pictures: overlay them at source size, then scale the combined frame.
        const overlay = `[${videoSpecifier}][0:${stream.index}]overlay=format=auto`;
        graph = chain.length ? `${overlay}[rozh_ov];[rozh_ov]${chain.join(',')}[rozh_base]` : `${overlay}[rozh_base]`;
      } else {
        throw new EncodeConfigError(`Subtitle format "${stream.codec_name}" cannot be burned in.`);
      }
    }
  } else if (chain.length) {
    simple = chain.join(',');
  }

  return { graph, simple, videoSpecifier };
}

/**
 * Complete FFmpeg argument list for one encode (excluding the executable).
 * `media` is required whenever the command depends on the source (scaling, embedded subtitles, per-track audio bitrates).
 */
export function buildFfmpegArgs(settings: EncodeSettings, media?: MediaInfo, arabicFont?: ArabicFontOverride): string[] {
  if (!isAbsolutePath(settings.input)) throw new EncodeConfigError('The input path must be absolute.');
  if (!isAbsolutePath(settings.output)) throw new EncodeConfigError('The output path must be absolute.');

  const args = ['-hide_banner', settings.overwrite ? '-y' : '-n', '-progress', 'pipe:1', '-nostats'];
  const iconv = SUBTITLE_ENCODINGS[settings.subtitleEncoding]?.iconv;
  const subtitles = settings.subtitles;

  // Trimming seeks every input to the same start point (input-side -ss is both fast and, on
  // modern FFmpeg, frame-accurate) so a soft/external subtitle track stays in sync with the
  // trimmed picture. The end point is enforced once, output-side, with -t below.
  const trim = settings.trim;
  const trimStart = trim?.startSec;
  const trimDuration = trim?.endSec !== undefined ? trim.endSec - (trimStart ?? 0) : undefined;
  if (trimStart !== undefined) args.push('-ss', formatSeekSeconds(trimStart));
  args.push('-i', settings.input);
  const externalSoft = subtitles.mode === 'keep' ? subtitles.external : undefined;
  if (externalSoft) {
    if (iconv) args.push('-sub_charenc', iconv);
    if (trimStart !== undefined) args.push('-ss', formatSeekSeconds(trimStart));
    args.push('-i', externalSoft);
  }

  const watermark = settings.watermark;
  let logoInput = -1;
  if (watermark) {
    if (!watermark.file) throw new EncodeConfigError('There is no watermark image.');
    logoInput = externalSoft ? 2 : 1;
    // -loop 1 turns a still image into an endless stream; the overlay uses shortest=1 so it ends with the main video.
    args.push('-loop', '1', '-i', watermark.file);
  }

  // ----- video path -----
  const { graph, simple, videoSpecifier } = buildVideoGraph(settings, media, iconv, arabicFont, trimStart);

  if (watermark) {
    const base = graph ?? `[${videoSpecifier}]${simple ?? 'null'}[rozh_base]`;
    args.push('-filter_complex', `${base};${watermarkGraph(watermark, logoInput, 'rozh_base', 'rozh_v', outputSize(settings, media))}`, '-map', '[rozh_v]');
  } else if (graph) {
    args.push('-filter_complex', graph.replace('[rozh_base]', '[rozh_v]'), '-map', '[rozh_v]');
  } else {
    if (simple) args.push('-vf', simple);
    args.push('-map', videoSpecifier);
  }

  // ----- audio and (soft) subtitle maps -----
  args.push('-map', '0:a?');
  const softTracks: string[] = [];
  if (subtitles.mode === 'keep') {
    const softCodec = settings.container === 'mp4' ? 'mov_text' : settings.container === 'webm' ? 'webvtt' : 'copy';
    for (const index of subtitles.embedded) {
      args.push('-map', `0:${index}`);
      softTracks.push(softCodec);
    }
    if (subtitles.external) {
      args.push('-map', '1:0');
      softTracks.push(externalSubtitleCodec(settings.container, subtitles.external));
    }
  }

  // ----- codecs -----
  args.push(...videoCodecArgs(settings, media));
  args.push(...audioCodecArgs(settings, media));
  softTracks.forEach((codec, n) => args.push(`-c:s:${n}`, codec));

  // Chapter markers carry timestamps from the untrimmed source, so they'd land outside (or make
  // no sense within) a trimmed output; drop them whenever a trim is in effect.
  args.push('-map_metadata', '0', '-map_chapters', trim ? '-1' : '0');
  if (trimDuration !== undefined) args.push('-t', formatSeekSeconds(trimDuration));
  if (settings.container === 'mp4') args.push('-movflags', '+faststart');
  args.push(settings.output);
  return args;
}

/**
 * Command that renders ONE frame (PNG) of the video with the subtitle burned in, for the
 * "Preview subtitle frame" button. It uses the very same filters as a real encode (scaling to the
 * output size, `subtitles=` with the same font directory, bitmap overlay, subtitle clock shift),
 * but skips audio, codecs, watermark and frame-rate conversion, so it finishes in about a second.
 * `atSec` is a position in the SOURCE file. `output` must be an absolute .png path.
 */
export function buildPreviewArgs(settings: EncodeSettings, media: MediaInfo, atSec: number, output: string, arabicFont?: ArabicFontOverride): string[] {
  if (!isAbsolutePath(settings.input)) throw new EncodeConfigError('The input path must be absolute.');
  if (!isAbsolutePath(output) || !/\.png$/i.test(output)) throw new EncodeConfigError('The preview must be written to an absolute .png path.');
  if (settings.subtitles.mode !== 'burn') throw new EncodeConfigError('The preview only applies when subtitles are burned in.');
  if (!Number.isFinite(atSec) || atSec < 0) throw new EncodeConfigError('The preview time must be zero or later.');

  const iconv = SUBTITLE_ENCODINGS[settings.subtitleEncoding]?.iconv;
  const { graph, simple, videoSpecifier } = buildVideoGraph({ ...settings, fps: undefined }, media, iconv, arabicFont, atSec);
  const args = ['-hide_banner', '-v', 'error', '-y', '-ss', formatSeekSeconds(atSec), '-i', settings.input];
  if (graph) args.push('-filter_complex', graph.replace('[rozh_base]', '[rozh_v]'), '-map', '[rozh_v]');
  else {
    if (simple) args.push('-vf', simple);
    args.push('-map', videoSpecifier);
  }
  args.push('-an', '-sn', '-dn', '-frames:v', '1', '-c:v', 'png', output);
  return args;
}

/**
 * Human-readable rendering of a command for the Command tab and log files.
 * DISPLAY ONLY: the app always executes argument arrays, never this string.
 */
export function formatCommand(executable: string, args: string[]): string {
  const quote = (value: string) => (/^[A-Za-z0-9_\-./:=+@,%]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`);
  return [executable, ...args].map(quote).join(' ');
}
