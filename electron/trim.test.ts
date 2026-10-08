import { describe, expect, it } from 'vitest';
import { buildEncodeSettings, DEFAULT_SETTINGS, formatTimecode, hasErrors, parseTimecode, validateEncode } from './rules';
import { fakeMedia } from './test-helpers';

const ALL = ['libx264', 'libx265', 'libsvtav1', 'libvpx-vp9'];

describe('buildEncodeSettings: trim', () => {
  it('carries the per-job trim choice into EncodeSettings', () => {
    const settings = buildEncodeSettings(DEFAULT_SETTINGS, 'C:\\a.mkv', 'C:\\a.mp4', false, { media: fakeMedia(), trimStartSec: 90, trimEndSec: 225 }, ALL);
    expect(settings.trim).toEqual({ startSec: 90, endSec: 225 });
  });

  it('leaves trim undefined when neither point was chosen', () => {
    const settings = buildEncodeSettings(DEFAULT_SETTINGS, 'C:\\a.mkv', 'C:\\a.mp4', false, { media: fakeMedia() }, ALL);
    expect(settings.trim).toBeUndefined();
  });
});

describe('validateEncode: trim', () => {
  const media = fakeMedia({ duration: 120 });
  const settingsWith = (startSec?: number, endSec?: number) =>
    buildEncodeSettings(DEFAULT_SETTINGS, 'C:\\a.mkv', 'C:\\a.mp4', false, { media, trimStartSec: startSec, trimEndSec: endSec }, ALL);

  it('accepts a valid range within the source duration', () => {
    expect(hasErrors(validateEncode(settingsWith(10, 60), media, ALL))).toBe(false);
  });

  it('errors when the end time is not after the start time', () => {
    const issues = validateEncode(settingsWith(60, 60), media, ALL);
    expect(issues.some(i => i.code === 'trim-range-invalid' && i.level === 'error')).toBe(true);
  });

  it('errors when the start time is at or past the end of the source', () => {
    const issues = validateEncode(settingsWith(120, undefined), media, ALL);
    expect(issues.some(i => i.code === 'trim-start-beyond-source' && i.level === 'error')).toBe(true);
  });

  it('only warns (does not error) when the end time runs past the source; FFmpeg will just stop at EOF', () => {
    const issues = validateEncode(settingsWith(10, 999), media, ALL);
    expect(issues.some(i => i.code === 'trim-end-beyond-source' && i.level === 'warning')).toBe(true);
    expect(hasErrors(issues)).toBe(false);
  });

  it('reports no trim issues when nothing was trimmed', () => {
    const settings = buildEncodeSettings(DEFAULT_SETTINGS, 'C:\\a.mkv', 'C:\\a.mp4', false, { media }, ALL);
    expect(validateEncode(settings, media, ALL).some(i => i.code.startsWith('trim-'))).toBe(false);
  });
});

describe('timecode formatting and parsing', () => {
  it('formats whole seconds as H:MM:SS or MM:SS', () => {
    expect(formatTimecode(225)).toBe('00:03:45');
    expect(formatTimecode(5525)).toBe('01:32:05');
    expect(formatTimecode(undefined)).toBe('');
  });

  it('parses HH:MM:SS, MM:SS, and bare seconds back to a second count', () => {
    expect(parseTimecode('00:01:30')).toBe(90);
    expect(parseTimecode('1:30')).toBe(90);
    expect(parseTimecode('90')).toBe(90);
    expect(parseTimecode('  ')).toBeUndefined();
  });

  it('flags unparseable text as NaN so the UI can tell it apart from "not set"', () => {
    expect(Number.isNaN(parseTimecode('not-a-time'))).toBe(true);
    expect(Number.isNaN(parseTimecode('1:2:3:4'))).toBe(true);
  });

  it('round-trips through format/parse', () => {
    expect(parseTimecode(formatTimecode(225))).toBe(225);
  });
});
