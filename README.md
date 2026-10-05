# Rozh

**A Kurdish-first desktop video encoder with precise control over video, audio, trimming, and subtitles.**

[Download Rozh 0.2.0 for Windows x64](https://github.com/Shiiv23/rozh-encoder/releases/latest) · [View all releases](https://github.com/Shiiv23/rozh-encoder/releases) · [Source and license](#development)

Rozh is built for people who want practical encoding controls and dependable subtitle burn-in in one desktop app. Add one video or build a queue, choose the output you want, preview a subtitle frame, and encode with FFmpeg and FFprobe included.

> **Windows:** The current downloadable installer is unsigned. Windows SmartScreen may show an unrecognized-app warning. FFmpeg and FFprobe are bundled; no separate FFmpeg install is needed.

## What Rozh can do

### Add, inspect, and queue videos

- Add local videos with the file picker or drag and drop.
- Inspect duration, dimensions, bitrate, chapters, and available video, audio, and subtitle tracks.
- Process one selected video or run a batch queue.
- Reorder and remove queued jobs; track progress, cancel an active encode, and get completion notifications.
- See media and encoding issues reported against the relevant file.

### Choose your output

- Export to **MP4, MKV, or WebM**.
- Choose **H.264/AVC, H.265/HEVC, AV1, or VP9**, subject to format and encoder compatibility.
- Select a quality preset—from source/lossless through smaller output—or set a custom quality value.
- Choose an encoding speed preset.
- Keep the source size and frame rate, or resize while preserving aspect ratio and choose a frame rate.
- Pick an output folder or file; Rozh plans output paths for queued videos.

### Control audio

- Copy compatible source audio without re-encoding, or convert to **AAC** or **Opus** where the chosen output format supports it.
- Select an audio bitrate for converted tracks.
- Review the source audio tracks before encoding.

### Trim clips

- Set precise start and end timecodes for each video.
- See the resulting clip length and clear the trim to encode the full video.

### Keep, add, or burn subtitles

- Keep selected embedded subtitle tracks, add an external subtitle as a selectable track, burn a subtitle into the picture, or omit subtitles.
- Work with external **SRT, ASS/SSA, VTT, SAMI, SubViewer, SBV, TTML/DFXP, and MPL2** subtitle files.
- Select the embedded subtitle stream or external file to burn in.
- Choose automatic encoding detection or an explicit text encoding for legacy subtitle files.
- Preview a rendered subtitle frame before encoding. Rozh can pick a representative line in the trim range, or preview a specific time.
- Preserve the subtitle file's authored font and styling instead of forcing a font. Arabic and Central Kurdish (Sorani) use right-to-left handling; a bundled font is available only as a fallback when glyphs are missing.

### Adjust the picture

- Add an image watermark and set its position, size, margin, and opacity.
- Choose from supported output sizes without distorting the original aspect ratio.

### Diagnose and manage encodes

- FFmpeg and FFprobe are bundled and checked by the app.
- If the bundled tools cannot run on a system, locate a different FFmpeg build from the app; the selection is remembered.
- Review per-job logs and app-wide encoder logs, open the log folder, or clear old logs.
- Follow live encode progress, cancel work, and configure completion notifications.

### Use Rozh in Kurdish Sorani or English

- Switch the interface between **Central Kurdish (Sorani)** and **English**.
- Sorani interface text uses right-to-left layout.

## Download and run

Download the **Windows x64 installer** from the [latest release](https://github.com/Shiiv23/rozh-encoder/releases/latest). The release ZIP contains the installer, third-party license texts, and SHA-256 checksums. Extract it and run `Rozh Setup 0.2.0.exe`.

The installer is currently unsigned, so Windows SmartScreen may display a warning. FFmpeg and FFprobe are bundled with the app; you do not need to install them separately.

## Development

Requirements: Node.js and npm.

```sh
npm install
npm run dev
```

`npm install` downloads the FFmpeg and FFprobe builds used by the current platform.

```sh
npm test
npm run build
```

Package an installer for the current platform, or target a specific platform:

```sh
npm run dist
npm run dist:win
npm run dist:mac
npm run dist:linux
```

The FFmpeg binaries are platform-specific. To package for a different OS or architecture, install dependencies for that target or build on the target platform/CI.

### Code signing and notarization

Distributable macOS and Windows builds should be signed. macOS builds also need notarization to avoid Gatekeeper warnings. The `package.json` build configuration and `build/notarize.js` support signing and notarization, but Rozh does not include signing credentials:

- **macOS:** Set `CSC_LINK` and `CSC_KEY_PASSWORD` for your Developer ID certificate, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` for notarization.
- **Windows:** Set `CSC_LINK` and `CSC_KEY_PASSWORD` for your code-signing certificate, and set `build.win.publisherName` in `package.json` to the certificate's subject name.

### Licenses

Rozh source code is MIT-licensed; bundled components have their own licenses. See [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) before redistributing the app.
