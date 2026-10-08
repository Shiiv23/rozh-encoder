import { describe, expect, it } from 'vitest';
import { adjustForContainer, buildEncodeSettings, DEFAULT_SETTINGS, selectableCodecs, validateEncode, validateGlobal, hasErrors } from './rules';
import { fakeMedia } from './test-helpers';

const ALL = ['libx264', 'libx265', 'libsvtav1', 'libvpx-vp9'];

describe('container consistency', () => {
  it('switching to WebM replaces H.264 with a WebM-capable codec and AAC with Opus, and says so', () => {
    const start = { ...DEFAULT_SETTINGS, codec: 'h264' as const, audioMode: 'aac' as const };
    const { settings, notes } = adjustForContainer(start, 'webm', ALL);
    expect(settings.container).toBe('webm');
    expect(['av1', 'vp9']).toContain(settings.codec);
    expect(settings.audioMode).toBe('opus');
    expect(notes).toHaveLength(2);
    expect(hasErrors(validateGlobal(settings, ALL))).toBe(false);
  });

  it('leaves settings untouched when they already fit', () => {
    const { settings, notes } = adjustForContainer(DEFAULT_SETTINGS, 'mkv', ALL);
    expect(notes).toEqual([]);
    expect(settings.codec).toBe(DEFAULT_SETTINGS.codec);
  });

  it('only offers codecs that the container allows and this FFmpeg build has', () => {
    expect(selectableCodecs('webm', ALL).sort()).toEqual(['av1', 'vp9']);
    expect(selectableCodecs('webm', ['libx264'])).toEqual([]);
    expect(selectableCodecs('mp4', ['libx264', 'libx265'])).toEqual(['h264', 'h265']);
  });

  it('H.264 in WebM is reported as an error (the real FFmpeg failure found in the audit)', () => {
    const settings = buildEncodeSettings({ ...DEFAULT_SETTINGS, container: 'webm', audioMode: 'opus' }, 'C:\\a.mkv', 'C:\\a.webm', false, { media: fakeMedia() }, ALL);
    expect(hasErrors(validateEncode(settings, fakeMedia(), ALL))).toBe(true);
  });
});
