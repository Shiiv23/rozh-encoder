import { basename } from './paths';
import type { MediaInfo, StreamInfo } from './types';

type RawProbe = {
  format?: Record<string, unknown>;
  streams?: StreamInfo[];
  chapters?: unknown[];
};

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Rotation in degrees from either the modern display-matrix side data or the legacy `rotate` tag. */
export function rotationOf(stream: StreamInfo): number {
  const matrix = stream.side_data_list?.find(item => typeof item.rotation === 'number');
  if (matrix) return matrix.rotation as number;
  const legacy = Number(stream.tags?.rotate);
  return Number.isFinite(legacy) ? legacy : 0;
}

/** Converts `ffprobe -of json -show_format -show_streams -show_chapters` output into MediaInfo. */
export function parseProbe(raw: unknown, filePath: string, fileSize?: number): MediaInfo {
  const parsed = (raw ?? {}) as RawProbe;
  const streams: StreamInfo[] = Array.isArray(parsed.streams) ? parsed.streams : [];
  const format = parsed.format ?? {};

  const video = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.filter(s => s.codec_type === 'audio');
  const subtitles = streams.filter(s => s.codec_type === 'subtitle');

  let duration = positiveNumber(format.duration);
  if (duration === undefined) {
    const streamDurations = streams.map(s => positiveNumber(s.duration)).filter((d): d is number => d !== undefined);
    if (streamDurations.length) duration = Math.max(...streamDurations);
  }

  let displayWidth = video?.width;
  let displayHeight = video?.height;
  if (video && displayWidth && displayHeight && Math.abs(Math.round(rotationOf(video))) % 180 === 90) {
    [displayWidth, displayHeight] = [displayHeight, displayWidth];
  }

  return {
    path: filePath,
    name: basename(filePath),
    size: positiveNumber(format.size) ?? fileSize ?? 0,
    format: typeof format.format_name === 'string' ? format.format_name : undefined,
    formatLong: typeof format.format_long_name === 'string' ? format.format_long_name : undefined,
    duration,
    bitRate: positiveNumber(format.bit_rate),
    streams,
    video,
    audio,
    subtitles,
    chapters: Array.isArray(parsed.chapters) ? parsed.chapters.length : 0,
    displayWidth,
    displayHeight,
    isHdr: video?.color_transfer === 'smpte2084' || video?.color_transfer === 'arib-std-b67'
  };
}
