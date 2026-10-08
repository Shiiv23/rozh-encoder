import type { ProgressInfo } from './types';

/**
 * Parses `ffmpeg -progress pipe:1` output. FFmpeg emits blocks of `key=value` lines that each end with
 * `progress=continue` or `progress=end`. Data arrives in arbitrary chunks, so lines are buffered and a
 * block is only processed once its `progress=` line has been seen.
 */
export class ProgressParser {
  private buffer = '';
  private block: Record<string, string> = {};

  constructor(private readonly durationSec: number | undefined, private readonly onUpdate: (info: ProgressInfo) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      this.block[key] = value;
      if (key === 'progress') {
        const info = this.toInfo(this.block, value === 'end');
        this.block = {};
        if (info) this.onUpdate(info);
      }
    }
  }

  private toInfo(block: Record<string, string>, ended: boolean): ProgressInfo | undefined {
    // `out_time_ms` is (despite its name) in microseconds, as is `out_time_us`. Negative or N/A means "not yet known".
    const micro = Number(block.out_time_us ?? block.out_time_ms);
    let timeSec = Number.isFinite(micro) && micro >= 0 ? micro / 1_000_000 : parseClock(block.out_time);
    if (timeSec === undefined) timeSec = 0;

    const speedMatch = /^([\d.]+)x$/.exec(block.speed ?? '');
    const speed = speedMatch ? Number(speedMatch[1]) : undefined;
    const fps = Number(block.fps);
    const size = Number(block.total_size);

    const known = this.durationSec && this.durationSec > 0;
    let percent: number | undefined;
    if (ended) percent = 100;
    else if (known) percent = Math.max(0, Math.min(99.9, (timeSec / (this.durationSec as number)) * 100));

    const etaSec = known && speed && speed > 0 && !ended ? Math.max(0, ((this.durationSec as number) - timeSec) / speed) : undefined;

    return {
      percent,
      timeSec,
      speed,
      fps: Number.isFinite(fps) && fps > 0 ? fps : undefined,
      sizeBytes: Number.isFinite(size) && size >= 0 ? size : undefined,
      etaSec
    };
  }
}

function parseClock(value?: string): number | undefined {
  const match = /^(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value ?? '');
  if (!match || match[1]) return undefined;
  return Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]);
}

// -----------------------------------------------------------------------------------------------

const KNOWN_ERRORS: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/No space left on device/i, () => 'The output drive is full.'],
  [/Permission denied/i, () => 'Permission denied. Check that the output folder is writable and the file is not open in another program.'],
  [/Unknown encoder '([^']+)'/i, m => `This FFmpeg build does not include the "${m[1]}" encoder.`],
  [/Encoder ([\w.-]+) not found/i, m => `This FFmpeg build does not include the "${m[1]}" encoder.`],
  [/Unrecognized option '([^']+)'/i, m => `FFmpeg does not recognise the option "${m[1]}". Your FFmpeg build may be too old — update it.`],
  [/Invalid data found when processing input/i, () => 'FFmpeg could not read the input. The file may be corrupt or in an unsupported format.'],
  [/No such file or directory/i, () => 'FFmpeg could not open a file. It may have been moved, renamed or deleted.'],
  [/Could not write header|Error initializing the muxer|Tag \S+ incompatible with output codec/i, () => 'The chosen container cannot store one of the selected streams. Try MKV, or change the codec/audio/subtitle settings.'],
  [/Invalid channel layout|Unsupported channel layout|channel layout .* not supported/i, () => 'The audio channel layout is not supported by the chosen audio encoder. Try AAC, or copy the audio.'],
  [/Error (?:opening|initializing|reinitializing) (?:the )?filters?|Error initializing complex filters|Unable to parse .*filter/i, () => 'FFmpeg could not set up the video filters (scaling or subtitles). Check the subtitle file and its encoding; see the log for details.'],
  [/Error while opening encoder/i, () => 'FFmpeg could not start the video encoder with these settings. See the log for details.']
];

const NOISE = /^(frame=|size=|video:|audio:|\[?(?:out|in)#\d|Stream mapping:|\s+Stream #|Press \[q\]|Conversion failed)/i;

/**
 * Turns raw FFmpeg stderr into a short message for the UI plus the last lines for a details view.
 * The complete stderr is always kept in the log file.
 */
export function summarizeFfmpegError(stderr: string, exitCode?: number | null): { summary: string; detail: string } {
  const lines = stderr.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const detail = lines.slice(-25).join('\n');
  for (const [pattern, describe] of KNOWN_ERRORS) {
    const match = pattern.exec(stderr);
    if (match) return { summary: describe(match), detail };
  }
  const meaningful = lines.filter(l => !NOISE.test(l));
  const tail = meaningful.slice(-2).join(' ');
  if (tail) return { summary: tail.length > 300 ? `${tail.slice(0, 297)}…` : tail, detail };
  return { summary: `FFmpeg stopped with exit code ${exitCode ?? 'unknown'} and gave no explanation.`, detail };
}
