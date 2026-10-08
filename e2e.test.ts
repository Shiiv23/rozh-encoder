import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildFfmpegArgs } from './electron/ffmpegArgs';
import { baseSettings } from './electron/test-helpers';

const run = promisify(execFile);

describe('e2e trim sanity', () => {
  it('actually trims a real file to the requested range', async () => {
    const input = '/home/claude/rozh/sample.mp4';
    const output = '/home/claude/rozh/trimmed.mp4';
    const settings = baseSettings({
      input, output, overwrite: true, quality: 'balanced',
      trim: { startSec: 2, endSec: 5 }
    });
    const args = buildFfmpegArgs(settings);
    console.log('ARGS:', args.join(' '));
    await run('ffmpeg', args);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', output]);
    const dur = parseFloat(stdout.trim());
    console.log('OUTPUT DURATION:', dur);
    expect(dur).toBeGreaterThan(2.7);
    expect(dur).toBeLessThan(3.3);
  }, 30000);
});
