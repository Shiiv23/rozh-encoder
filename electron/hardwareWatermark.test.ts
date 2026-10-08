import { describe, expect, it } from 'vitest';
import { buildFfmpegArgs } from './ffmpegArgs';
import { DEFAULT_SETTINGS, buildEncodeSettings, resolveHardware, validateGlobal } from './rules';
import type { MediaInfo } from './types';

const media: MediaInfo = {
  path: '/v/in.mkv', name: 'in.mkv', size: 1, duration: 10, streams: [],
  video: { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p' },
  audio: [], subtitles: [], chapters: 0, displayWidth: 1920, displayHeight: 1080, isHdr: false
};
const ENC = ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'h264_videotoolbox', 'h264_qsv', 'h264_amf'];

const build = (patch: Partial<typeof DEFAULT_SETTINGS>) =>
  buildEncodeSettings({ ...DEFAULT_SETTINGS, subtitleMode: 'none', ...patch }, '/v/in.mkv', '/v/out.mp4', false, { media }, ENC);

describe('hardware encoders', () => {
  it('auto picks NVENC first', () => expect(resolveHardware('auto', 'h264', ENC)).toBe('nvenc'));
  it('off stays software', () => expect(build({ hwAccel: 'off' }).hardware).toBeUndefined());
  it.each([
    ['nvenc', 'h264_nvenc', '-cq'],
    ['qsv', 'h264_qsv', '-global_quality'],
    ['amf', 'h264_amf', '-qp_i'],
    ['videotoolbox', 'h264_videotoolbox', '-q:v']
  ] as const)('%s builds %s', (hw, name, flag) => {
    const args = buildFfmpegArgs(build({ hwAccel: hw }), media);
    expect(args[args.indexOf('-c:v') + 1]).toBe(name);
    expect(args).toContain(flag);
    expect(args).not.toContain('-crf');
  });
  it('flags a missing backend', () => {
    expect(validateGlobal({ ...DEFAULT_SETTINGS, codec: 'h265', hwAccel: 'amf' }, ENC).some(i => i.code === 'hw-missing')).toBe(true);
  });
});

describe('watermark', () => {
  it('adds a looped logo input and overlay', () => {
    const args = buildFfmpegArgs(build({ watermark: { enabled: true, file: '/v/logo.png', position: 'top-left', sizePct: 10, marginPct: 2, opacityPct: 50 }, shortEdge: 720 }), media);
    expect(args.slice(args.indexOf('-loop'), args.indexOf('-loop') + 4)).toEqual(['-loop', '1', '-i', '/v/logo.png']);
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('[1:v]scale=128:-2');
    expect(graph).toContain('aa=0.500');
    expect(graph).toContain('overlay=x=14:y=14');
    expect(args[args.indexOf('-map') + 1]).toBe('[rozh_v]');
  });
  it('requires an image when enabled', () => {
    expect(validateGlobal({ ...DEFAULT_SETTINGS, watermark: { ...DEFAULT_SETTINGS.watermark, enabled: true } }).some(i => i.code === 'watermark-file')).toBe(true);
  });
});
