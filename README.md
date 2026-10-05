# Rozh

I built Rozh as a desktop video encoder with Kurdish Sorani and Arabic subtitle support.

[Download the Windows version](https://github.com/Shiiv23/rozh-encoder/releases/latest) · [All releases](https://github.com/Shiiv23/rozh-encoder/releases)

Drop in a video, choose your settings, and encode. You can queue up more files for batch jobs. FFmpeg and FFprobe are included.

**Windows:** The installer is unsigned, so SmartScreen may show a warning.

## What it does

- **Video:** Export to MP4, MKV, or WebM. Choose H.264, H.265, AV1, or VP9 where supported. Pick a quality and speed preset, set custom quality, keep the source size and frame rate, or resize and set a frame rate.
- **Audio:** Copy compatible tracks or convert to AAC or Opus where supported. Choose a bitrate for converted audio.
- **Trim:** Set start and end timecodes for each file and check the resulting length.
- **Subtitles:** Keep embedded tracks, add an external subtitle track, burn a subtitle into the picture, or leave subtitles out. External formats include SRT, ASS/SSA, VTT, SAMI, SubViewer, SBV, TTML/DFXP, and MPL2. Choose which track or file to burn and set the text encoding if needed.
- **Preview:** Render a subtitle frame before encoding. Use a representative subtitle in the trim range or enter a specific time.
- **Arabic and Sorani:** Subtitle text uses right-to-left handling. I don't override the font or styling set in the subtitle file; a bundled font is only a fallback when glyphs are missing.
- **Watermark:** Add an image and adjust its position, size, margin, and opacity.
- **Queue:** Reorder jobs, follow progress, cancel an encode, and get completion notifications.
- **Media details:** Check duration, dimensions, bitrate, chapters, and video, audio, and subtitle streams.
- **Logs and FFmpeg:** Check job and encoder logs. If the bundled FFmpeg won't run, choose another build in the app.
- **Interface:** Switch between Central Kurdish (Sorani) and English.

## Install

Download the Windows x64 ZIP from the [latest release](https://github.com/Shiiv23/rozh-encoder/releases/latest), extract it, and run `Rozh Setup 0.2.0.exe`. FFmpeg and FFprobe are bundled, so you don't need to install them separately.

The installer isn't code-signed, so Windows SmartScreen may show an unrecognized-app warning.

## Run from source

You need Node.js and npm.

```sh
npm install
npm run dev
```

Run the tests and build:

```sh
npm test
npm run build
```

Build an installer:

```sh
npm run dist
npm run dist:win
npm run dist:mac
npm run dist:linux
```

FFmpeg binaries are platform-specific. To build for another OS or architecture, install dependencies for that target or build on the target platform.

### Signing

Public macOS and Windows builds should be signed; macOS builds should also be notarized. Signing credentials aren't included. The build configuration is in `package.json` and `build/notarize.js`.

### License

My source code is MIT-licensed. Bundled components have their own licenses; see [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
