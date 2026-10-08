// Pure rules shared by the renderer (to explain and gate controls) and the main process
// (to re-validate before spawning FFmpeg). No Node imports.

import { basename, extname, isAbsolutePath, samePath } from './paths';
import type {
  AudioMode,
  Container,
  EncodeSettings,
  GlobalSettings,
  HwAccelChoice,
  HwBackend,
  Issue,
  MediaInfo,
  QualityPreset,
  StreamInfo,
  SubtitleEncoding,
  SubtitleSettings,
  VideoCodec,
  VideoEncoder
} from './types';

// ---------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------

export const CONTAINER_INFO: Record<Container, {
  label: string;
  ext: string;
  videoCodecs: VideoCodec[];
  /** Source audio codecs that may be stream-copied. `null` means anything. */
  audioCopy: string[] | null;
  audioEncode: AudioMode[];
}> = {
  mp4: { label: 'MP4', ext: 'mp4', videoCodecs: ['h264', 'h265', 'av1', 'vp9'], audioCopy: ['aac', 'mp3', 'ac3', 'eac3', 'opus'], audioEncode: ['aac', 'opus'] },
  mkv: { label: 'MKV (Matroska)', ext: 'mkv', videoCodecs: ['h264', 'h265', 'av1', 'vp9'], audioCopy: null, audioEncode: ['aac', 'opus'] },
  webm: { label: 'WebM', ext: 'webm', videoCodecs: ['av1', 'vp9'], audioCopy: ['opus', 'vorbis'], audioEncode: ['opus'] }
};

export const CODEC_INFO: Record<VideoCodec, { label: string; encoders: VideoEncoder[] }> = {
  h264: { label: 'H.264 / AVC', encoders: ['libx264'] },
  h265: { label: 'H.265 / HEVC', encoders: ['libx265'] },
  // SVT-AV1 is preferred: libaom is far slower for the same job.
  av1: { label: 'AV1', encoders: ['libsvtav1', 'libaom-av1'] },
  vp9: { label: 'VP9', encoders: ['libvpx-vp9'] }
};

export const ENCODER_LABEL: Record<VideoEncoder, string> = {
  libx264: 'x264',
  libx265: 'x265',
  libsvtav1: 'SVT-AV1',
  'libaom-av1': 'libaom',
  'libvpx-vp9': 'libvpx-vp9'
};

export const QUALITY_ORDER: QualityPreset[] = ['source', 'lossless', 'veryHigh', 'high', 'balanced', 'small', 'custom'];

/** Constant-quality (CRF) values. Lower is better quality and a bigger file. These are starting points, not guarantees. */
const CRF_TABLE: Record<VideoEncoder, Record<Exclude<QualityPreset, 'custom'>, number>> = {
  libx264: { lossless: 14, veryHigh: 17, source: 18, high: 20, balanced: 23, small: 28 },
  libx265: { lossless: 16, veryHigh: 19, source: 20, high: 22, balanced: 26, small: 30 },
  libsvtav1: { lossless: 20, veryHigh: 24, source: 26, high: 28, balanced: 32, small: 38 },
  'libaom-av1': { lossless: 20, veryHigh: 24, source: 26, high: 28, balanced: 32, small: 38 },
  'libvpx-vp9': { lossless: 15, veryHigh: 19, source: 20, high: 24, balanced: 31, small: 37 }
};

export function crfRange(encoder: VideoEncoder): { min: number; max: number } {
  return encoder === 'libx264' || encoder === 'libx265' ? { min: 1, max: 51 } : { min: 1, max: 63 };
}

export function crfFor(encoder: VideoEncoder, quality: QualityPreset, customCrf?: number): number {
  if (quality === 'custom') {
    const range = crfRange(encoder);
    const value = Number.isFinite(customCrf) ? Math.round(customCrf as number) : CRF_TABLE[encoder].balanced;
    return Math.min(range.max, Math.max(range.min, value));
  }
  return CRF_TABLE[encoder][quality];
}

export const SHORT_EDGE_CHOICES = [2160, 1440, 1080, 720, 576, 480, 360];
export const FPS_CHOICES = [24, 25, 30, 50, 60];
export const AUDIO_BITRATE_CHOICES = [96, 128, 160, 192, 256, 320];
export const DEFAULT_AUDIO_KBPS: Record<Exclude<AudioMode, 'copy'>, number> = { aac: 192, opus: 128 };

export const SUBTITLE_ENCODINGS: Record<SubtitleEncoding, { label: string; iconv?: string }> = {
  // Kurdish Sorani needs UTF-8: Windows-1256 has no ڵ ۆ ێ ڕ etc., so files in that encoding cannot hold Sorani text.
  auto: { label: 'Automatic (detects UTF-8, UTF-16, Windows-1256)' },
  'utf-8': { label: 'Unicode (UTF-8) — Kurdish, Arabic, all languages', iconv: 'UTF-8' },
  cp1256: { label: 'Arabic legacy (Windows-1256)', iconv: 'CP1256' },
  cp1254: { label: 'Turkish / Kurmanji (Windows-1254)', iconv: 'CP1254' },
  cp1252: { label: 'Western European (Windows-1252)', iconv: 'CP1252' },
  cp1251: { label: 'Cyrillic (Windows-1251)', iconv: 'CP1251' }
};

// FFmpeg reads .srt/.ass/.ssa/.vtt/.smi (and SubViewer-style .sub) straight off disk; MicroDVD
// .sub, .mpl2, .sbv and .ttml/.dfxp are converted to .srt first — see subtitleConvert.ts.
export const EXTERNAL_SUBTITLE_EXTENSIONS = ['.srt', '.ass', '.ssa', '.vtt', '.smi', '.sub', '.sbv', '.ttml', '.dfxp', '.mpl2'];

export const DEFAULT_SETTINGS: GlobalSettings = {
  container: 'mp4',
  codec: 'h264',
  quality: 'balanced',
  customCrf: 23,
  speed: 'balanced',
  audioMode: 'copy',
  audioBitrateKbps: 192,
  shortEdge: 'source',
  fps: 'source',
  subtitleMode: 'keep',
  subtitleEncoding: 'auto',
  hwAccel: 'off',
  watermark: { enabled: false, position: 'bottom-right', sizePct: 12, marginPct: 3, opacityPct: 80 }
};

// ---------------------------------------------------------------------------------------------
// Hardware encoders
// ---------------------------------------------------------------------------------------------

export const HW_BACKENDS: HwBackend[] = ['nvenc', 'qsv', 'amf', 'videotoolbox'];

export const HW_LABEL: Record<HwBackend, string> = {
  nvenc: 'NVIDIA NVENC',
  videotoolbox: 'Apple VideoToolbox',
  qsv: 'Intel Quick Sync (QSV)',
  amf: 'AMD AMF'
};

/** FFmpeg encoder names per backend and codec. Missing entries mean the vendor has no such encoder. */
export const HW_ENCODERS: Record<HwBackend, Partial<Record<VideoCodec, string>>> = {
  nvenc: { h264: 'h264_nvenc', h265: 'hevc_nvenc', av1: 'av1_nvenc' },
  videotoolbox: { h264: 'h264_videotoolbox', h265: 'hevc_videotoolbox' },
  qsv: { h264: 'h264_qsv', h265: 'hevc_qsv', av1: 'av1_qsv', vp9: 'vp9_qsv' },
  amf: { h264: 'h264_amf', h265: 'hevc_amf', av1: 'av1_amf' }
};

export function hardwareEncoderName(backend: HwBackend, codec: VideoCodec): string | undefined {
  return HW_ENCODERS[backend][codec];
}

/** Backends that exist in this FFmpeg build for `codec`. */
export function availableHardware(codec: VideoCodec, availableEncoders: string[]): HwBackend[] {
  return HW_BACKENDS.filter(b => {
    const name = hardwareEncoderName(b, codec);
    return !!name && availableEncoders.includes(name);
  });
}

/** Resolves the user's choice to a concrete backend, or undefined for software encoding. */
export function resolveHardware(choice: HwAccelChoice, codec: VideoCodec, availableEncoders: string[]): HwBackend | undefined {
  if (choice === 'off') return undefined;
  const available = availableHardware(codec, availableEncoders);
  if (choice === 'auto') return available[0];
  return available.includes(choice) ? choice : undefined;
}

export const WATERMARK_POSITIONS = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right'
] as const;

// ---------------------------------------------------------------------------------------------
// Codec / encoder helpers
// ---------------------------------------------------------------------------------------------

export function codecOfEncoder(encoder: VideoEncoder): VideoCodec {
  return (Object.keys(CODEC_INFO) as VideoCodec[]).find(codec => CODEC_INFO[codec].encoders.includes(encoder)) ?? 'h264';
}

/** First encoder for `codec` that this FFmpeg build actually has. */
export function resolveEncoder(codec: VideoCodec, availableEncoders: string[]): VideoEncoder | undefined {
  return CODEC_INFO[codec].encoders.find(name => availableEncoders.includes(name));
}

export function isCodecAllowedInContainer(container: Container, codec: VideoCodec): boolean {
  return CONTAINER_INFO[container].videoCodecs.includes(codec);
}

export function allowedCodecsFor(container: Container): string {
  return CONTAINER_INFO[container].videoCodecs.map(c => CODEC_INFO[c].label).join(', ');
}

export function isAudioModeAllowed(container: Container, mode: AudioMode): boolean {
  return mode === 'copy' || CONTAINER_INFO[container].audioEncode.includes(mode);
}

// ---------------------------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------------------------

const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'microdvd', 'subviewer', 'subviewer1', 'sami', 'ttml', 'realtext', 'jacosub', 'mpl2', 'pjs', 'stl', 'vplayer']);
const BITMAP_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

export function subtitleKind(codec?: string): 'text' | 'bitmap' | 'unknown' {
  if (!codec) return 'unknown';
  if (TEXT_SUBTITLE_CODECS.has(codec)) return 'text';
  if (BITMAP_SUBTITLE_CODECS.has(codec)) return 'bitmap';
  return 'unknown';
}

/** Can this embedded track be kept as a soft (selectable) track in `container`? */
export function subtitleFitsContainer(container: Container, codec?: string): { ok: boolean; reason?: string } {
  const kind = subtitleKind(codec);
  if (container === 'mkv') return kind === 'unknown' && !codec ? { ok: false, reason: 'Unknown subtitle format.' } : { ok: true };
  if (kind === 'text') return { ok: true };
  const name = CONTAINER_INFO[container].label;
  if (kind === 'bitmap') return { ok: false, reason: `Image-based subtitles (${codec}) cannot be stored in ${name}. Use MKV, or burn them into the video.` };
  return { ok: false, reason: `The subtitle format "${codec ?? 'unknown'}" cannot be stored in ${name}.` };
}

export function isBurnableEmbedded(codec?: string): boolean {
  const kind = subtitleKind(codec);
  return kind === 'text' || kind === 'bitmap';
}

export function streamLanguage(stream: StreamInfo): string {
  return stream.tags?.language ?? stream.tags?.LANGUAGE ?? '';
}

export function streamTitle(stream: StreamInfo): string {
  return stream.tags?.title ?? stream.tags?.TITLE ?? '';
}

// ---------------------------------------------------------------------------------------------
// Media helpers
// ---------------------------------------------------------------------------------------------

export function parseFrameRate(value?: string): number | undefined {
  if (!value || value === '0/0') return undefined;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator)) return undefined;
  if (denominator === undefined) return numerator > 0 ? numerator : undefined;
  if (!Number.isFinite(denominator) || denominator === 0) return undefined;
  const fps = numerator / denominator;
  return fps > 0 ? fps : undefined;
}

export function videoBitDepth(stream?: StreamInfo): number {
  if (!stream) return 8;
  const raw = Number(stream.bits_per_raw_sample);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const fmt = stream.pix_fmt ?? '';
  if (/(10|12|14|16)(le|be)$/.test(fmt) || /p010|p012/.test(fmt)) return /12/.test(fmt) ? 12 : 10;
  return 8;
}

/**
 * Output size for a "shorter edge ≤ N" cap. Never upscales, preserves aspect ratio, keeps dimensions even.
 * Returns undefined when no scaling is needed.
 */
export function computeScaleTarget(width: number | undefined, height: number | undefined, shortEdge: number | undefined): { width: number; height: number } | undefined {
  if (!shortEdge || !width || !height) return undefined;
  const currentShort = Math.min(width, height);
  if (currentShort <= shortEdge) return undefined;
  const factor = shortEdge / currentShort;
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(width * factor), height: even(height * factor) };
}

// ---------------------------------------------------------------------------------------------
// Formatting for the UI
// ---------------------------------------------------------------------------------------------

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Renders seconds as an editable HH:MM:SS(.ms) timecode. Sub-second precision is kept only when present. */
export function formatTimecode(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '';
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const secondsPart = Number.isInteger(s) ? two(s) : s.toFixed(3).padStart(6, '0');
  return `${two(h)}:${two(m)}:${secondsPart}`;
}

/**
 * Parses a user-typed timecode into seconds. Accepts `HH:MM:SS`, `MM:SS`, or a bare number of
 * seconds, all with optional fractional seconds (`.` decimal point). Returns undefined for
 * empty input and NaN for anything unparseable, so callers can tell "not set" from "invalid".
 */
export function parseTimecode(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(':');
  if (parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  const nums = parts.map(Number);
  const seconds = nums.pop() ?? 0;
  const minutes = nums.pop() ?? 0;
  const hours = nums.pop() ?? 0;
  return hours * 3600 + minutes * 60 + seconds;
}

export function formatBitrate(bitsPerSecond?: number | string): string {
  const value = Number(bitsPerSecond);
  if (!Number.isFinite(value) || value <= 0) return '—';
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} Mb/s` : `${Math.round(value / 1000)} kb/s`;
}

export function formatFps(fps?: number): string {
  if (!fps) return '—';
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const issue = (level: Issue['level'], code: string, message: string): Issue => ({ level, code, message });

/** Checks that need no media file: container/codec/audio combinations and encoder availability. */
export function validateGlobal(settings: GlobalSettings, availableEncoders?: string[]): Issue[] {
  const issues: Issue[] = [];
  const container = CONTAINER_INFO[settings.container];
  if (!isCodecAllowedInContainer(settings.container, settings.codec)) {
    issues.push(issue('error', 'container-codec', `${CODEC_INFO[settings.codec].label} cannot be stored in ${container.label}. ${container.label} supports: ${allowedCodecsFor(settings.container)}.`));
  }
  if (availableEncoders && !resolveEncoder(settings.codec, availableEncoders)) {
    issues.push(issue('error', 'encoder-missing', `This FFmpeg build has no ${CODEC_INFO[settings.codec].label} software encoder (${CODEC_INFO[settings.codec].encoders.join(' or ')}).`));
  }
  if (!isAudioModeAllowed(settings.container, settings.audioMode)) {
    issues.push(issue('error', 'container-audio', `${container.label} cannot store ${settings.audioMode.toUpperCase()} audio. Choose ${container.audioEncode.map(m => m.toUpperCase()).join(' or ')}, or switch container.`));
  }
  if (settings.hwAccel !== 'off' && settings.hwAccel !== 'auto') {
    const name = hardwareEncoderName(settings.hwAccel, settings.codec);
    if (!name) issues.push(issue('error', 'hw-codec', `${HW_LABEL[settings.hwAccel]} cannot encode ${CODEC_INFO[settings.codec].label}.`));
    else if (availableEncoders && !availableEncoders.includes(name)) issues.push(issue('error', 'hw-missing', `This FFmpeg build has no ${name} encoder. Choose Automatic or Off, or install a build with ${HW_LABEL[settings.hwAccel]} support.`));
  } else if (settings.hwAccel === 'auto' && availableEncoders && !resolveHardware('auto', settings.codec, availableEncoders)) {
    issues.push(issue('info', 'hw-fallback', `No hardware encoder for ${CODEC_INFO[settings.codec].label} was found; Rozh will use the software encoder.`));
  }
  if (settings.watermark.enabled) {
    if (!settings.watermark.file) issues.push(issue('error', 'watermark-file', 'Choose a logo image for the watermark, or turn the watermark off.'));
  }
  if (settings.quality === 'custom') {
    const encoder = resolveEncoder(settings.codec, availableEncoders ?? CODEC_INFO[settings.codec].encoders) ?? CODEC_INFO[settings.codec].encoders[0];
    const range = crfRange(encoder);
    if (!Number.isFinite(settings.customCrf) || settings.customCrf < range.min || settings.customCrf > range.max) {
      issues.push(issue('error', 'custom-crf', `Custom quality (CRF) must be between ${range.min} and ${range.max} for ${ENCODER_LABEL[encoder]}.`));
    }
  }
  return issues;
}

/** Full validation of one FFmpeg run against the real media file. */
export function validateEncode(settings: EncodeSettings, media?: MediaInfo, availableEncoders?: string[]): Issue[] {
  const issues: Issue[] = [];
  const codec = codecOfEncoder(settings.videoEncoder);
  const container = CONTAINER_INFO[settings.container];

  if (!isAbsolutePath(settings.input)) issues.push(issue('error', 'input-path', 'The input path must be an absolute path.'));
  if (!isAbsolutePath(settings.output)) issues.push(issue('error', 'output-path', 'The output path must be an absolute path.'));
  else if (samePath(settings.input, settings.output)) issues.push(issue('error', 'output-is-input', 'The output file is the same as the source file. Rozh never overwrites a source file — choose a different output.'));
  else if (extname(settings.output) !== `.${container.ext}`) issues.push(issue('error', 'output-extension', `The output file name must end in .${container.ext} for the ${container.label} container.`));

  if (media && !media.video) issues.push(issue('error', 'no-video', 'This file has no video stream, so there is nothing to encode.'));

  if (!isCodecAllowedInContainer(settings.container, codec)) {
    issues.push(issue('error', 'container-codec', `${CODEC_INFO[codec].label} cannot be stored in ${container.label}. ${container.label} supports: ${allowedCodecsFor(settings.container)}.`));
  }
  if (settings.hardware) {
    const name = hardwareEncoderName(settings.hardware, codec);
    if (!name) issues.push(issue('error', 'hw-codec', `${HW_LABEL[settings.hardware]} cannot encode ${CODEC_INFO[codec].label}.`));
    else if (availableEncoders && !availableEncoders.includes(name)) issues.push(issue('error', 'hw-missing', `This FFmpeg build does not include the ${name} encoder.`));
  } else if (availableEncoders && !availableEncoders.includes(settings.videoEncoder)) {
    issues.push(issue('error', 'encoder-missing', `This FFmpeg build does not include the ${settings.videoEncoder} encoder.`));
  }
  if (settings.watermark) {
    const wm = settings.watermark;
    if (!wm.file) issues.push(issue('error', 'watermark-file', 'Choose a logo image for the watermark.'));
    else if (!isAbsolutePath(wm.file)) issues.push(issue('error', 'watermark-path', 'The watermark image path must be absolute.'));
    if (!(wm.sizePct >= 1 && wm.sizePct <= 100)) issues.push(issue('error', 'watermark-size', 'Watermark size must be between 1% and 100%.'));
    if (!(wm.marginPct >= 0 && wm.marginPct <= 25)) issues.push(issue('error', 'watermark-margin', 'Watermark margin must be between 0% and 25%.'));
    if (!(wm.opacityPct >= 0 && wm.opacityPct <= 100)) issues.push(issue('error', 'watermark-opacity', 'Watermark opacity must be between 0% and 100%.'));
  }

  if (!isAudioModeAllowed(settings.container, settings.audioMode)) {
    issues.push(issue('error', 'container-audio', `${container.label} cannot store ${settings.audioMode.toUpperCase()} audio. Choose ${container.audioEncode.map(m => m.toUpperCase()).join(' or ')}.`));
  } else if (settings.audioMode === 'copy' && container.audioCopy && media) {
    const bad = media.audio.filter(a => !container.audioCopy!.includes(a.codec_name ?? ''));
    if (bad.length) {
      const names = [...new Set(bad.map(a => a.codec_name ?? 'unknown'))].join(', ');
      issues.push(issue('error', 'audio-copy', `Audio (${names}) cannot be copied into ${container.label}. Choose AAC or Opus to convert it, or use MKV.`));
    }
  }

  if (settings.quality === 'custom') {
    const range = crfRange(settings.videoEncoder);
    if (!Number.isFinite(settings.customCrf) || (settings.customCrf as number) < range.min || (settings.customCrf as number) > range.max) {
      issues.push(issue('error', 'custom-crf', `Custom quality (CRF) must be between ${range.min} and ${range.max} for ${ENCODER_LABEL[settings.videoEncoder]}.`));
    }
  }
  if (settings.shortEdge !== undefined && (!Number.isInteger(settings.shortEdge) || settings.shortEdge < 16 || settings.shortEdge > 8640)) {
    issues.push(issue('error', 'scale-invalid', 'The resolution limit is not a valid size.'));
  }
  if (settings.fps !== undefined && (!Number.isFinite(settings.fps) || settings.fps <= 0 || settings.fps > 240)) {
    issues.push(issue('error', 'fps-invalid', 'The frame rate is not valid.'));
  }

  issues.push(...validateTrim(settings.trim, media));
  issues.push(...validateSubtitles(settings.subtitles, settings.container, media));

  // Warnings and notes
  if (media?.video) {
    const sourceFps = parseFrameRate(media.video.avg_frame_rate) ?? parseFrameRate(media.video.r_frame_rate);
    if (settings.fps && sourceFps && settings.fps > sourceFps + 0.5) {
      issues.push(issue('warning', 'fps-upsample', `The source is ${formatFps(sourceFps)} fps; converting to ${settings.fps} fps duplicates frames and will not improve smoothness.`));
    }
    if (settings.shortEdge && media.displayWidth && media.displayHeight && !computeScaleTarget(media.displayWidth, media.displayHeight, settings.shortEdge)) {
      issues.push(issue('info', 'scale-noop', `The source is already ${Math.min(media.displayWidth, media.displayHeight)}p or smaller, so it will not be resized (Rozh never upscales).`));
    }
    if (media.isHdr && settings.videoEncoder === 'libx264') {
      issues.push(issue('warning', 'hdr-8bit', 'This looks like HDR video. H.264 output is 8-bit and Rozh does not tone-map, so colours will look washed out. Use H.265 or AV1 to keep 10-bit.'));
    }
  }
  if (settings.quality === 'lossless') issues.push(issue('info', 'lossless-size', 'Visually Lossless uses a very low CRF; expect files as large as, or larger than, the source.'));
  return issues;
}

function validateTrim(trim: EncodeSettings['trim'], media?: MediaInfo): Issue[] {
  if (!trim) return [];
  const issues: Issue[] = [];
  const { startSec, endSec } = trim;
  if (startSec !== undefined && (!Number.isFinite(startSec) || startSec < 0)) {
    issues.push(issue('error', 'trim-start-invalid', 'The trim start time is not valid.'));
  }
  if (endSec !== undefined && (!Number.isFinite(endSec) || endSec <= 0)) {
    issues.push(issue('error', 'trim-end-invalid', 'The trim end time is not valid.'));
  }
  if (startSec !== undefined && endSec !== undefined && Number.isFinite(startSec) && Number.isFinite(endSec) && endSec <= startSec) {
    issues.push(issue('error', 'trim-range-invalid', 'The trim end time must be after the start time.'));
  }
  if (media?.duration !== undefined) {
    if (startSec !== undefined && Number.isFinite(startSec) && startSec >= media.duration) {
      issues.push(issue('error', 'trim-start-beyond-source', `The trim start time is at or after the end of the source (${formatDuration(media.duration)}).`));
    } else if (endSec !== undefined && Number.isFinite(endSec) && endSec > media.duration) {
      issues.push(issue('warning', 'trim-end-beyond-source', `The trim end time is beyond the source's length (${formatDuration(media.duration)}); Rozh will stop at the end of the file.`));
    }
  }
  return issues;
}

function validateSubtitles(subtitles: SubtitleSettings, container: Container, media?: MediaInfo): Issue[] {
  const issues: Issue[] = [];
  const name = CONTAINER_INFO[container].label;
  if (subtitles.mode === 'keep') {
    for (const index of subtitles.embedded) {
      const stream = media?.subtitles.find(s => s.index === index);
      if (media && !stream) { issues.push(issue('error', 'subtitle-missing', `Subtitle track #${index} does not exist in the source.`)); continue; }
      const fit = subtitleFitsContainer(container, stream?.codec_name);
      if (!fit.ok) issues.push(issue('error', 'subtitle-container', `Subtitle track #${index}: ${fit.reason}`));
      else if (container !== 'mkv' && (stream?.codec_name === 'ass' || stream?.codec_name === 'ssa')) {
        issues.push(issue('warning', 'subtitle-styling', `Subtitle track #${index} is styled (ASS/SSA). ${name} stores plain text only, so colours, fonts and positioning will be lost.`));
      }
    }
    if (subtitles.external && !EXTERNAL_SUBTITLE_EXTENSIONS.includes(extname(subtitles.external))) {
      issues.push(issue('error', 'subtitle-file', `"${basename(subtitles.external)}" is not a supported subtitle file (${EXTERNAL_SUBTITLE_EXTENSIONS.join(', ')}).`));
    }
    if (subtitles.external && container !== 'mkv' && ['.ass', '.ssa'].includes(extname(subtitles.external))) {
      issues.push(issue('warning', 'subtitle-styling', `The external ASS/SSA file will be converted to plain text in ${name}; styling is lost. Burn it in or use MKV to keep it.`));
    }
  }
  if (subtitles.mode === 'burn') {
    const source = subtitles.source;
    if (!source) {
      issues.push(issue('error', 'burn-no-source', 'There is no subtitle to burn in: this file has no embedded subtitle track and no external subtitle file was chosen.'));
    } else if (source.kind === 'external') {
      if (!EXTERNAL_SUBTITLE_EXTENSIONS.includes(extname(source.file))) issues.push(issue('error', 'subtitle-file', `"${basename(source.file)}" is not a supported subtitle file (${EXTERNAL_SUBTITLE_EXTENSIONS.join(', ')}).`));
    } else {
      const stream = media?.subtitles.find(s => s.index === source.streamIndex);
      if (media && !stream) issues.push(issue('error', 'subtitle-missing', `Subtitle track #${source.streamIndex} does not exist in the source.`));
      else if (stream && !isBurnableEmbedded(stream.codec_name)) issues.push(issue('error', 'burn-unsupported', `Subtitle format "${stream.codec_name}" cannot be burned in.`));
    }
    if (source) issues.push(issue('info', 'burn-reencode', 'Burning subtitles into the picture requires re-encoding the video. The subtitle becomes part of the image and cannot be turned off.'));
  }
  return issues;
}

export const hasErrors = (issues: Issue[]) => issues.some(i => i.level === 'error');

// ---------------------------------------------------------------------------------------------
// Turning batch-wide settings + one job into EncodeSettings
// ---------------------------------------------------------------------------------------------

export interface JobSubtitleChoice {
  media?: MediaInfo;
  /** External subtitle chosen for this file. */
  externalSubtitle?: string;
  /** Embedded tracks to keep. `undefined` = every track that fits the container. */
  keepSubtitles?: number[];
  /** Embedded track to burn when no external file is set. `undefined` = default/first track. */
  burnStream?: number;
  /** Seconds from the start of the source to begin encoding at. `undefined` = from the start. */
  trimStartSec?: number;
  /** Seconds from the start of the source to stop encoding at. `undefined` = through the end. */
  trimEndSec?: number;
}

export function defaultBurnStream(media?: MediaInfo): number | undefined {
  if (!media?.subtitles.length) return undefined;
  const candidates = media.subtitles.filter(s => isBurnableEmbedded(s.codec_name));
  return (candidates.find(s => s.disposition?.default) ?? candidates[0])?.index;
}

export function defaultKeepSubtitles(media: MediaInfo | undefined, container: Container): number[] {
  return (media?.subtitles ?? []).filter(s => subtitleFitsContainer(container, s.codec_name).ok).map(s => s.index);
}

export function buildEncodeSettings(
  global: GlobalSettings,
  input: string,
  output: string,
  overwrite: boolean,
  choice: JobSubtitleChoice,
  availableEncoders: string[]
): EncodeSettings {
  const encoder = resolveEncoder(global.codec, availableEncoders) ?? CODEC_INFO[global.codec].encoders[0];
  // "Same as Source" means exactly that: no resizing and no frame-rate change.
  const keepSource = global.quality === 'source';

  let subtitles: SubtitleSettings;
  if (global.subtitleMode === 'none') {
    subtitles = { mode: 'none' };
  } else if (global.subtitleMode === 'burn') {
    const stream = choice.burnStream ?? defaultBurnStream(choice.media);
    subtitles = {
      mode: 'burn',
      source: choice.externalSubtitle
        ? { kind: 'external', file: choice.externalSubtitle }
        : stream !== undefined ? { kind: 'embedded', streamIndex: stream } : undefined
    };
  } else {
    subtitles = {
      mode: 'keep',
      embedded: choice.keepSubtitles ?? defaultKeepSubtitles(choice.media, global.container),
      external: choice.externalSubtitle
    };
  }

  return {
    input,
    output,
    container: global.container,
    videoEncoder: encoder,
    quality: global.quality,
    customCrf: global.quality === 'custom' ? global.customCrf : undefined,
    speed: global.speed,
    audioMode: global.audioMode,
    audioBitrateKbps: global.audioMode === 'copy' ? undefined : global.audioBitrateKbps,
    shortEdge: keepSource || global.shortEdge === 'source' ? undefined : global.shortEdge,
    fps: keepSource || global.fps === 'source' ? undefined : global.fps,
    subtitles,
    subtitleEncoding: global.subtitleEncoding,
    trim: choice.trimStartSec !== undefined || choice.trimEndSec !== undefined
      ? { startSec: choice.trimStartSec, endSec: choice.trimEndSec }
      : undefined,
    hardware: resolveHardware(global.hwAccel ?? 'off', global.codec, availableEncoders),
    watermark: global.watermark?.enabled ? { ...global.watermark } : undefined,
    overwrite
  };
}

// ---------------------------------------------------------------------------------------------
// Keeping batch-wide settings self-consistent
// ---------------------------------------------------------------------------------------------

/** Codecs the user can pick right now: allowed in the container and present in this FFmpeg build. */
export function selectableCodecs(container: Container, availableEncoders: string[]): VideoCodec[] {
  return (Object.keys(CODEC_INFO) as VideoCodec[]).filter(c => isCodecAllowedInContainer(container, c) && !!resolveEncoder(c, availableEncoders));
}

/**
 * Switches container and repairs whatever no longer fits (codec, audio mode) so the UI never sits in a state
 * that can only fail. `notes` says what was changed so the user is told rather than surprised.
 */
export function adjustForContainer(settings: GlobalSettings, container: Container, availableEncoders: string[]): { settings: GlobalSettings; notes: string[] } {
  const next: GlobalSettings = { ...settings, container };
  const notes: string[] = [];
  const label = CONTAINER_INFO[container].label;

  if (!isCodecAllowedInContainer(container, next.codec)) {
    const options = selectableCodecs(container, availableEncoders);
    const replacement = options[0] ?? CONTAINER_INFO[container].videoCodecs[0];
    notes.push(`${CODEC_INFO[next.codec].label} cannot be stored in ${label}; the video codec was changed to ${CODEC_INFO[replacement].label}.`);
    next.codec = replacement;
  }
  if (!isAudioModeAllowed(container, next.audioMode)) {
    const replacement = CONTAINER_INFO[container].audioEncode[0];
    notes.push(`${label} cannot store ${next.audioMode.toUpperCase()} audio; the audio mode was changed to ${replacement.toUpperCase()}.`);
    next.audioMode = replacement;
    next.audioBitrateKbps = DEFAULT_AUDIO_KBPS[replacement as 'aac' | 'opus'];
  }
  return { settings: next, notes };
}
