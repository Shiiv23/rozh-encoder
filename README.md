# Rozh

Rozh is a desktop video encoder with Kurdish Sorani and Arabic subtitle support. Add videos, choose how they should look and sound, check a subtitle frame, then encode one file or run a queue. FFmpeg and FFprobe are included.

[Download for Windows](https://github.com/Shiiv23/rozh-encoder/releases/latest) · [Other releases](https://github.com/Shiiv23/rozh-encoder/releases)

> **Windows:** The installer isn't signed, so SmartScreen may show a warning.

## What you can do

### Add videos and manage the queue

- Pick one or more videos, or drag them into the queue. Common formats include MP4, MKV, WebM, MOV, AVI, M4V, TS, M2TS, MPG, WMV, FLV, OGV, and 3GP.
- Check each file's status, progress, and output name as Rozh analyzes and encodes it.
- Encode the selected file or start the whole queue. Reorder jobs, remove or reset a job, clear completed jobs, or stop a running encode.
- Follow progress, speed, FPS, and ETA when available. Desktop notifications can be enabled for completed runs.

### Choose the output

- Save as **MP4, MKV, or WebM**. Outputs are named automatically beside the source file, or in a folder you choose. You can also choose an output filename for the selected video.
- Pick **H.264/AVC, H.265/HEVC, AV1, or VP9**, subject to the selected container and available FFmpeg encoders.
- Choose a quality preset: **Source, Visually Lossless, Very High, High, Balanced, Small**, or **Custom**. Custom quality uses the encoder's CRF scale: 1–51 for x264/x265 and 1–63 for AV1/VP9 software encoders. Presets are quality starting points, not promises of a particular file size.
- Choose **Fast, Balanced, or Slow** encoding speed.
- Keep the source resolution, or set a maximum short edge of **2160, 1440, 1080, 720, 576, 480, or 360 pixels**. Scaling preserves the aspect ratio and only scales down; smaller sources are left as-is.
- Keep the source frame rate or choose **24, 25, 30, 50, or 60 FPS**.
- Choose hardware encoding **Off**, **Automatic**, or a detected NVIDIA NVENC, Apple VideoToolbox, Intel Quick Sync, or AMD AMF option where available for the selected codec. Automatic uses a compatible available hardware encoder and otherwise falls back to software.

### Set the audio

- Copy compatible source audio without re-encoding, or convert to **AAC** or **Opus** where the selected container supports it.
- Choose **96, 128, 160, 192, 256, or 320 kb/s** for converted audio.
- Review detected audio tracks, including codec, channels, and language when available.

### Trim a video

- Set a start time, end time, or both for each queued file. Enter `HH:MM:SS`, `MM:SS`, or seconds; fractional seconds are accepted.
- See the resulting clip length and clear the trim to use the whole video.

### Handle subtitles

- Choose to **keep** compatible embedded tracks, **add** an external subtitle track, **burn** a subtitle into the picture, or omit subtitles.
- External formats include **SRT, ASS/SSA, VTT, SAMI, SubViewer, SBV, TTML/DFXP, and MPL2**.
- Select the embedded track or external file to burn. Choose automatic text-encoding detection or specify UTF-8, Windows-1256, Windows-1254, Windows-1252, or Windows-1251 for legacy files.
- Preview one rendered frame before encoding. Leave the time blank to preview a representative subtitle in the trim range, or enter a time to check a specific moment. This is a still-frame preview, not subtitle playback.
- Arabic and Sorani subtitles get right-to-left handling. Subtitle-authored fonts and styling aren't overridden; bundled Noto Naskh Arabic and Noto Sans Arabic are only fallbacks for missing glyphs (Noto Sans Arabic includes Central Kurdish coverage). Fonts named in subtitles, such as Adobe Arabic, are used when installed on the user's device. Some containers support fewer subtitle styles than others, and Rozh reports compatibility issues.
- Burning subtitles makes them part of the picture and requires video re-encoding.

### Add a watermark

Add a PNG, JPG/JPEG, WebP, or BMP image. Choose one of nine positions and adjust its size (**2–50%**), margin (**0–15%**), and opacity (**5–100%**). PNG and WebP transparency is supported.

### Inspect files and troubleshoot

- Check file size, format, duration, bitrate, and chapters, plus video codec/profile, display dimensions, HDR/bit depth, frame rate, and audio/subtitle tracks.
- See warnings and errors for unsupported or incompatible settings before encoding.
- FFmpeg and FFprobe are bundled. Re-check them, switch to a different FFmpeg executable, or switch back to the bundled one in **Tools**.
- Open a selected video's encode log or browse the app-wide encoder logs. Refresh the log list, open its folder, or clear old logs.
- The status bar shows FFmpeg availability and queue progress; when available, it also shows current speed, FPS, and ETA.

### Use Rozh in Kurdish or English

The interface is available in **English** and **Central Kurdish (Sorani)**. The Kurdish interface uses right-to-left layout.

## Install

Download `Rozh Setup 0.2.1.exe` from the [latest release](https://github.com/Shiiv23/rozh-encoder/releases/latest) and run it. FFmpeg, FFprobe, and Arabic subtitle fallback fonts are bundled.

The installer isn't code-signed, so Windows SmartScreen may show an unrecognized-app warning.

## License

Rozh's source code is MIT-licensed. Bundled components have their own licenses; see [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
