# Rozh

Rozh is a Kurdish-first, cross-platform desktop media encoder built with Electron, React, and FFmpeg.

## Run locally

1. Run `npm install`. This also downloads a static FFmpeg/FFprobe build for your platform via `ffmpeg-static`/`ffprobe-static` — no separate FFmpeg install needed.
2. Run `npm run dev`.

`npm run build` produces the renderer bundle and Electron main-process files. `npm test` validates FFmpeg argument construction, including Unicode/Kurdish paths and subtitle filters.

`npm run dist` (or `dist:mac` / `dist:win` / `dist:linux`) builds a packaged, installable app with `electron-builder`. The bundled FFmpeg/FFprobe are platform-specific, so if you're packaging for a platform other than the one you're on, delete `node_modules` and reinstall with `npm_config_platform`/`npm_config_arch` set (or on the target platform/CI) before packaging — see the [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) and [ffprobe-static](https://github.com/eugeneware/ffprobe-static) READMEs.

### Code signing & notarization

Unsigned builds trigger Gatekeeper ("app is damaged"/unidentified developer) warnings on macOS and SmartScreen warnings on Windows, so a public release build needs real signing credentials. The `package.json` `build` config and `build/notarize.js` are wired up for this, but **you must supply your own credentials** — none are included here:

- **macOS**: get a "Developer ID Application" certificate from an active Apple Developer Program membership, then export it as a `.p12` and set:
  - `CSC_LINK` — path or base64 of the `.p12` file
  - `CSC_KEY_PASSWORD` — its export password
  - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (from <https://appleid.apple.com>), `APPLE_TEAM_ID` — used by `build/notarize.js` to notarize the signed `.dmg` after `dist:mac` builds it. Without these three set, the build still succeeds but logs a warning and ships unnotarized (Gatekeeper will still block it).
- **Windows**: get a code-signing certificate (an EV cert avoids SmartScreen's reputation-building delay; a standard OV cert works but SmartScreen warnings taper off over time as the binary accumulates reputation) and set `CSC_LINK` / `CSC_KEY_PASSWORD` for it as well — electron-builder auto-detects those env vars for both platforms. Update `build.win.publisherName` in `package.json` to match the certificate's subject name.

None of the above is required for local dev builds (`npm run dev`, `npm start`) — only for `npm run dist*` builds you intend to distribute publicly.

### Third-party licenses

Rozh's own code is MIT-licensed (`LICENSE`). It bundles FFmpeg/FFprobe, which are LGPL/GPL-licensed — see `THIRD_PARTY_NOTICES.md` for what that requires of anyone distributing Rozh (in short: keeping the license notice, and providing a way for recipients to get the matching FFmpeg source). If you upgrade `ffmpeg-static`/`ffprobe-static` later, update the version/commit link in that file to match what you're actually shipping.

Advanced/override options, if the bundled copy doesn't work on someone's machine (unsupported platform, a custom FFmpeg build with extra codecs, etc.):
- Set `FFMPEG_PATH` / `FFPROBE_PATH` env vars, or
- Use Tools → Locate FFmpeg… in the app, which is remembered until Tools → Use Bundled FFmpeg is chosen again.

## Implemented vertical slice

- Local-file picker and drag-style empty state
- FFprobe media inspection for container, duration, video, audio, and subtitle streams
- Safe FFmpeg process spawning with argument arrays, not shell string concatenation
- MP4/MKV/WebM, basic quality choices, codecs, audio copying/conversion, and aspect-ratio-safe scaling
- External SRT/ASS/SSA/VTT-style subtitle burn-in and embedded-track selection
- **Preview subtitle frame** (Subtitles tab, burn-in mode): renders one frame with the subtitle burned in, in about a second, using the same preparation, fonts and filters as the real encode. By default it picks the longest subtitle line inside the trim range so wrapping and font problems show up; enter a time to check a specific moment.
- Duration-based real FFmpeg progress and cancellation
- Kurdish Sorani / English switch with RTL layout

- FFmpeg and FFprobe ship inside the app (via `ffmpeg-static`/`ffprobe-static`), so installing Rozh is enough — no separate FFmpeg setup step. Rozh still detects binaries at runtime and falls back to a clear "Locate FFmpeg…" flow if the bundled copy can't run on someone's machine.
