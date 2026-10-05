# Rozh

Rozh is a desktop video encoder with Kurdish Sorani and Arabic subtitle support. Add a video, set the encode options, preview a subtitle frame, and start encoding. FFmpeg and FFprobe are included.

[Download for Windows](https://github.com/Shiiv23/rozh-encoder/releases/latest) · [Other releases](https://github.com/Shiiv23/rozh-encoder/releases)

> **Windows:** The installer is unsigned, so SmartScreen may show a warning.

## Features

- **Video:** MP4, MKV, or WebM; H.264, H.265, AV1, or VP9 where supported. Use a quality or speed preset, set custom quality, keep the source size and frame rate, or resize.
- **Audio:** Copy compatible tracks or convert to AAC or Opus where supported. Set the bitrate for converted audio.
- **Trim:** Set start and end timecodes and check the resulting clip length.
- **Subtitles:** Keep embedded tracks, add an external track, burn a subtitle into the picture, or leave subtitles out. External formats include SRT, ASS/SSA, VTT, SAMI, SubViewer, SBV, TTML/DFXP, and MPL2. Choose a track or file to burn and set its text encoding.
- **Preview:** Render a subtitle frame before encoding, using a representative line in the trim range or a time of your choice.
- **Arabic and Sorani:** Right-to-left subtitle handling that keeps the font and styling from the subtitle file. A bundled font is used only when glyphs are missing.
- **Watermark:** Add an image and adjust its position, size, margin, and opacity.
- **Queue:** Reorder jobs, track progress, cancel an encode, and get completion notifications.
- **Media details:** Check duration, dimensions, bitrate, chapters, and video, audio, and subtitle streams.
- **Logs and FFmpeg:** View job and encoder logs. If the bundled FFmpeg won't run, choose another build in the app.
- **Interface:** Switch between Central Kurdish (Sorani) and English.

## Install

Download the Windows x64 ZIP from the [latest release](https://github.com/Shiiv23/rozh-encoder/releases/latest), extract it, and run `Rozh Setup 0.2.0.exe`. FFmpeg and FFprobe are bundled.

The installer isn't code-signed, so Windows SmartScreen may show an unrecognized-app warning.

## Run from source

Requires Node.js and npm.

```sh
npm install
npm run dev
```

```sh
npm test
npm run build
```

Build an installer with `npm run dist`, or target a platform with `npm run dist:win`, `npm run dist:mac`, or `npm run dist:linux`. FFmpeg binaries are platform-specific, so build on the target platform or install dependencies for that OS and architecture.

### Signing

Public macOS and Windows builds should be signed; macOS builds should also be notarized. Signing credentials aren't included. See `package.json` and `build/notarize.js` for the build configuration.

### License

Rozh's source code is MIT-licensed. Bundled components have their own licenses; see [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
