import { describe, expect, it } from 'vitest';
import { cueDifficulty, parseSrtCues, pickPreviewTime, pngSize, visibleText } from './subtitlePreview';

const SRT = `1
00:00:01,000 --> 00:00:03,000
سڵاو

2
00:00:04,000 --> 00:00:09,000
ئەمە دێڕێکی زۆر درێژە بۆ تاقیکردنەوەی
لەتکردنی دێڕەکان

3
00:01:10,500 --> 00:01:12,000
<i>باش</i>
`;

describe('parseSrtCues', () => {
  it('reads times and text, including Kurdish text and hours/minutes', () => {
    const cues = parseSrtCues(SRT);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ start: 1, end: 3, text: 'سڵاو' });
    expect(cues[1].text).toContain('\n');
    expect(cues[2].start).toBe(70.5);
    expect(cues[2].text).toBe('باش');
  });

  it('copes with a BOM, CRLF line endings and cue numbers being absent', () => {
    const cues = parseSrtCues('\uFEFF00:00:02,000 --> 00:00:04,000\r\nhello\r\n\r\n00:00:05,0 --> 00:00:06,5\r\nworld\r\n');
    expect(cues.map(c => c.text)).toEqual(['hello', 'world']);
    expect(cues[1]).toEqual({ start: 5, end: 6.5, text: 'world' });
  });

  it('skips cues that have no visible text and ignores garbage', () => {
    expect(parseSrtCues('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}\n\nnot a cue')).toEqual([]);
    expect(parseSrtCues('')).toEqual([]);
  });
});

describe('visibleText', () => {
  it('removes ASS override blocks and tags and turns \\N into a line break', () => {
    expect(visibleText('{\\an8}<b>one</b>\\Ntwo')).toBe('one\ntwo');
  });
});

describe('pickPreviewTime', () => {
  const cues = parseSrtCues(SRT);

  it('prefers the most demanding cue and samples its middle', () => {
    const pick = pickPreviewTime({ cues });
    expect(pick.how).toBe('longest-line');
    expect(pick.timeSec).toBe(6.5); // middle of 4s..9s
  });

  it('only considers cues inside the trim range', () => {
    const pick = pickPreviewTime({ cues, trimStartSec: 60, trimEndSec: 100 });
    expect(pick.how).toBe('longest-line');
    expect(pick.timeSec).toBeGreaterThan(70);
    expect(pick.timeSec).toBeLessThan(72);
  });

  it('uses the visible part of a cue that straddles the trim start', () => {
    const pick = pickPreviewTime({ cues, trimStartSec: 6 });
    expect(pick.timeSec).toBe(7.5); // middle of 6s..9s
  });

  it('lets an explicit time win, clamped into the file', () => {
    expect(pickPreviewTime({ cues, requestedSec: 2 })).toEqual({ timeSec: 2, how: 'requested' });
    expect(pickPreviewTime({ cues, requestedSec: 999, durationSec: 120 }).timeSec).toBeCloseTo(119.9, 5);
    expect(pickPreviewTime({ cues, requestedSec: -5 }).timeSec).toBe(0);
  });

  it('falls back to just after the start of the range when no text is available', () => {
    expect(pickPreviewTime({ cues: [] })).toEqual({ timeSec: 1, how: 'fallback' });
    expect(pickPreviewTime({ cues: [], trimStartSec: 30 })).toEqual({ timeSec: 31, how: 'fallback' });
  });

  it('never lands past the end of a short video', () => {
    expect(pickPreviewTime({ cues: [], durationSec: 0.5 }).timeSec).toBeCloseTo(0.4, 5);
  });
});

describe('cueDifficulty', () => {
  it('ranks a long line above a short one, and (for equal line length) more lines above fewer', () => {
    expect(cueDifficulty('a much longer line of text')).toBeGreaterThan(cueDifficulty('short'));
    expect(cueDifficulty('abcd\nabcd')).toBeGreaterThan(cueDifficulty('abcd'));
    // The longest line dominates: it is what overflows the width and forces wrapping.
    expect(cueDifficulty('abcdef')).toBeGreaterThan(cueDifficulty('abc\nabc'));
  });
});

describe('pngSize', () => {
  it('reads the dimensions from a PNG header and rejects other data', () => {
    const header = new Uint8Array(24);
    header.set([0x89, 0x50, 0x4e, 0x47], 0);
    new DataView(header.buffer).setUint32(16, 1920);
    new DataView(header.buffer).setUint32(20, 1080);
    expect(pngSize(header)).toEqual({ width: 1920, height: 1080 });
    expect(pngSize(new Uint8Array(24))).toBeUndefined();
  });
});
