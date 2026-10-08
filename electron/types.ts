// Shared type contract for the main process, the preload bridge and the renderer.
// This file must stay free of Node/Electron imports so the renderer can import it.

export type Container = 'mp4' | 'mkv' | 'webm';
export type VideoCodec = 'h264' | 'h265' | 'av1' | 'vp9';
export type VideoEncoder = 'libx264' | 'libx265' | 'libsvtav1' | 'libaom-av1' | 'libvpx-vp9';
export type AudioMode = 'copy' | 'aac' | 'opus';
export type QualityPreset = 'source' | 'lossless' | 'veryHigh' | 'high' | 'balanced' | 'small' | 'custom';
export type SpeedPreset = 'fast' | 'balanced' | 'slow';
/** Text encoding of an external subtitle file. 'auto' detects UTF-8 / UTF-16 / legacy Arabic codepages. */
export type SubtitleEncoding = 'auto' | 'utf-8' | 'cp1256' | 'cp1254' | 'cp1252' | 'cp1251';
/** Hardware encoder families. 'auto' picks the first one this FFmpeg build has for the chosen codec. */
export type HwBackend = 'nvenc' | 'videotoolbox' | 'qsv' | 'amf';
export type HwAccelChoice = 'off' | 'auto' | HwBackend;
export type WatermarkPosition =
  | 'top-left' | 'top-center' | 'top-right'
  | 'center-left' | 'center' | 'center-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface WatermarkSettings {
  enabled: boolean;
  /** Absolute path to a PNG/JPG/WebP logo. Transparency in PNG/WebP is preserved. */
  file?: string;
  position: WatermarkPosition;
  /** Logo width as a percentage of the output picture width (1-100). */
  sizePct: number;
  /** Distance from the edges as a percentage of the shorter output edge (0-25). */
  marginPct: number;
  /** 0-100. */
  opacityPct: number;
}

/**
 * Cuts the encode down to a sub-range of the source. Either end may be omitted to mean
 * "from the very start" / "through to the very end". Values are seconds from the start
 * of the source file, and may carry fractional seconds.
 */
export interface TrimSettings {
  startSec?: number;
  endSec?: number;
}

export type JobStatus = 'pending' | 'analyzing' | 'ready' | 'encoding' | 'complete' | 'failed' | 'cancelled';

export interface StreamInfo {
  index: number;
  codec_type: string;
  codec_name?: string;
  codec_long_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  display_aspect_ratio?: string;
  field_order?: string;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_range?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  bit_rate?: string;
  duration?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  side_data_list?: Array<Record<string, unknown>>;
}

export interface MediaInfo {
  path: string;
  name: string;
  /** Size in bytes (0 if unknown). */
  size: number;
  format?: string;
  formatLong?: string;
  /** Seconds. Undefined when the container does not report a duration. */
  duration?: number;
  /** Bits per second. */
  bitRate?: number;
  streams: StreamInfo[];
  /** First real video stream (attached cover art is ignored). */
  video?: StreamInfo;
  audio: StreamInfo[];
  subtitles: StreamInfo[];
  chapters: number;
  /** Picture size after applying rotation metadata (what the viewer actually sees). */
  displayWidth?: number;
  displayHeight?: number;
  isHdr: boolean;
}

export type SubtitleSettings =
  | { mode: 'none' }
  /** Keep selected embedded tracks (absolute stream indexes) and optionally add an external file as a soft track. */
  | { mode: 'keep'; embedded: number[]; external?: string }
  /** Hard-code one subtitle into the picture. Requires re-encoding video. `source` is missing when nothing is available to burn. */
  | { mode: 'burn'; source?: { kind: 'embedded'; streamIndex: number } | { kind: 'external'; file: string } };

/** Fully resolved settings for one FFmpeg run. */
export interface EncodeSettings {
  input: string;
  output: string;
  container: Container;
  videoEncoder: VideoEncoder;
  quality: QualityPreset;
  customCrf?: number;
  speed: SpeedPreset;
  audioMode: AudioMode;
  audioBitrateKbps?: number;
  /** Cap on the shorter picture edge. Never upscales; aspect ratio is always preserved. */
  shortEdge?: number;
  fps?: number;
  subtitles: SubtitleSettings;
  subtitleEncoding: SubtitleEncoding;
  /** Encode only this sub-range of the source. Omitted = the whole file. */
  trim?: TrimSettings;
  /** When set, the matching hardware encoder (e.g. h264_nvenc) is used instead of `videoEncoder`. */
  hardware?: HwBackend;
  /** Logo overlay. Only present when enabled. */
  watermark?: WatermarkSettings;
  /** Replace an existing output file. Only set after the user confirmed replacement in a save dialog. */
  overwrite: boolean;
}

/** Batch-wide settings edited in the UI. Per-file details (which subtitle track, external file) live on the job. */
export interface GlobalSettings {
  container: Container;
  codec: VideoCodec;
  quality: QualityPreset;
  customCrf: number;
  speed: SpeedPreset;
  audioMode: AudioMode;
  audioBitrateKbps: number;
  shortEdge: number | 'source';
  fps: number | 'source';
  subtitleMode: 'keep' | 'none' | 'burn';
  subtitleEncoding: SubtitleEncoding;
  hwAccel: HwAccelChoice;
  watermark: WatermarkSettings;
}

export interface ProgressInfo {
  /** 0-100, undefined when the input duration is unknown. */
  percent?: number;
  timeSec: number;
  speed?: number;
  fps?: number;
  sizeBytes?: number;
  etaSec?: number;
}

export type EncodeResult =
  | { status: 'complete'; output: string; logPath?: string }
  | { status: 'failed'; error: string; detail?: string; logPath?: string }
  | { status: 'cancelled'; logPath?: string };

/** Result of rendering one frame with the subtitle burned in (the "Preview subtitle frame" button). */
export type SubtitlePreviewResult =
  | {
      status: 'ok';
      /** PNG picture, base64-encoded (use as `data:image/png;base64,...`). */
      png: string;
      /** Position in the source file that was rendered, in seconds. */
      timeSec: number;
      /** 'requested' = the time the user typed; 'longest-line' = picked automatically; 'fallback' = no subtitle text was readable, so the start of the range was used. */
      how: 'requested' | 'longest-line' | 'fallback';
      width?: number;
      height?: number;
    }
  | { status: 'failed'; error: string };

export interface BinaryStatus {
  found: boolean;
  version: string;
  /** The command or absolute path that was tried. */
  path: string;
  error?: string;
}

export interface FfmpegStatus {
  /** True only when both ffmpeg and ffprobe run. */
  available: boolean;
  ffmpeg: BinaryStatus;
  ffprobe: BinaryStatus;
  /** Encoder names reported by `ffmpeg -encoders`. */
  encoders: string[];
  /** Hardware encoders that were detected (NVENC, VideoToolbox, QSV, AMF, ...). */
  hardware: string[];
  problem?: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  logDir: string;
}

/** One log file sitting in Rozh's log directory (a past encode, or a main-process crash dump). */
export interface LogFileInfo {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

export type Issue = { level: 'error' | 'warning' | 'info'; code: string; message: string };

export type MenuCommand =
  | 'add-files'
  | 'remove'
  | 'move-up'
  | 'move-down'
  | 'clear-finished'
  | 'reset'
  | 'choose-output-folder'
  | 'choose-output-file'
  | 'start-queue'
  | 'encode-selected'
  | 'stop'
  | 'toggle-notify'
  | 'locate-ffmpeg'
  | 'reset-ffmpeg'
  | 'recheck-ffmpeg'
  | 'view-encoder-logs'
  | 'open-logs'
  | 'set-lang-en'
  | 'set-lang-ckb'
  | 'ffmpeg-help'
  | 'about';

/** What the renderer tells the native menu so it can enable/disable items. */
export interface MenuState {
  running: boolean;
  hasSelection: boolean;
  canRemove: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canStartQueue: boolean;
  canEncodeSelected: boolean;
  canChooseOutputFile: boolean;
  canReset: boolean;
  hasFinished: boolean;
  /** Whether a system notification is sent when an encode run finishes. Drives the checkbox in the Encode menu. */
  notifyOnComplete: boolean;
  /** Drives the radio selection in View > Language. */
  lang: 'en' | 'ckb';
}

export interface RozhApi {
  appInfo(): Promise<AppInfo>;
  ffmpegStatus(): Promise<FfmpegStatus>;
  /** Lets the user pick an ffmpeg executable; ffprobe is looked up next to it. Returns fresh status. */
  locateFfmpeg(): Promise<FfmpegStatus | undefined>;
  /** Forgets any manually located ffmpeg/ffprobe and goes back to the copy Rozh ships with. Returns fresh status. */
  resetFfmpeg(): Promise<FfmpegStatus>;
  openMediaDialog(): Promise<string[]>;
  openSubtitleDialog(): Promise<string | undefined>;
  openImageDialog(): Promise<string | undefined>;
  chooseOutputFolder(): Promise<string | undefined>;
  chooseOutputFile(defaultName: string, container: Container, defaultDir?: string): Promise<{ path: string; exists: boolean } | undefined>;
  /** Returns a non-existing output path that does not collide with `taken`. */
  planOutput(request: { input: string; folder?: string; container: Container; taken: string[] }): Promise<string>;
  inspect(file: string): Promise<MediaInfo>;
  start(jobId: string, settings: EncodeSettings): Promise<EncodeResult>;
  cancel(jobId: string): Promise<boolean>;
  /** Renders one frame with the subtitle burned in, using the same filters as a real encode. `atSec` omitted = the most demanding subtitle line. */
  previewSubtitle(settings: EncodeSettings, atSec?: number): Promise<SubtitlePreviewResult>;
  onProgress(listener: (jobId: string, info: ProgressInfo) => void): () => void;
  readLog(logPath: string): Promise<string>;
  openLogFolder(): Promise<void>;
  /** Every log file Rozh has written (past encodes and crash dumps), newest first. */
  listLogs(): Promise<LogFileInfo[]>;
  /** Deletes every file in the log directory. */
  clearLogs(): Promise<void>;
  /** Shows a system notification, if the OS/Electron supports one. Silently does nothing otherwise. */
  notify(options: { title: string; body: string }): Promise<void>;
  showInFolder(file: string): Promise<void>;
  pathsFromFiles(files: File[]): string[];
  setMenuState(state: MenuState): void;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
}
