// Shared fixtures for unit tests. Not part of the production build.
import { basename } from './paths';
import type { EncodeSettings, MediaInfo, StreamInfo } from './types';

export function stream(partial: Partial<StreamInfo> & { index: number; codec_type: string }): StreamInfo {
  return { ...partial };
}

export function fakeMedia(overrides: Partial<MediaInfo> = {}): MediaInfo {
  const streams: StreamInfo[] = [
    stream({ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '25/1', pix_fmt: 'yuv420p' }),
    stream({ index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'eng' } }),
    stream({ index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } }),
    stream({ index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'kur' } })
  ];
  return {
    path: 'C:\\Videos\\movie.mkv',
    name: 'movie.mkv',
    size: 1_000_000,
    format: 'matroska,webm',
    duration: 120,
    streams,
    video: streams[0],
    audio: streams.filter(s => s.codec_type === 'audio'),
    subtitles: streams.filter(s => s.codec_type === 'subtitle'),
    chapters: 0,
    displayWidth: 1920,
    displayHeight: 1080,
    isHdr: false,
    ...overrides
  };
}

export function baseSettings(overrides: Partial<EncodeSettings> = {}): EncodeSettings {
  return {
    input: 'C:\\Videos\\movie.mkv',
    output: 'C:\\Out\\movie_Rozh.mp4',
    container: 'mp4',
    videoEncoder: 'libx264',
    quality: 'balanced',
    speed: 'balanced',
    audioMode: 'copy',
    subtitles: { mode: 'none' },
    subtitleEncoding: 'auto',
    overwrite: false,
    ...overrides
  };
}

export const nameOf = basename;
