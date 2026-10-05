# Third-Party Notices

Rozh's own source code is licensed under the MIT License (see `LICENSE`).
Rozh bundles the following third-party components, which are licensed
separately and are **not** covered by the MIT License above.

## FFmpeg / FFprobe

Rozh ships prebuilt `ffmpeg` and `ffprobe` binaries (via the `ffmpeg-static`
and `ffprobe-static` npm packages) and invokes them as separate processes;
Rozh does not link against FFmpeg libraries. The bundled Windows x64
`ffmpeg-static@5.3.0` binary reports FFmpeg 6.1.1. Its accompanying binary
license file identifies the **GNU General Public License, version 3**. The
`ffmpeg-static` npm package also declares GPL-3.0-or-later. The full texts
shipped with the release are in `third-party-licenses/`.

The `ffprobe-static@3.1.0` npm wrapper declares the MIT License; its license
text is included in `third-party-licenses/`. FFprobe is part of FFmpeg, and
the applicable license for the distributed FFprobe binary is determined by
the specific binary build.

The FFmpeg package identifies its upstream 6.1.1 binary release and source
materials at <https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1>.
The FFmpeg 6.1.1 upstream source is also available at
<https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz>. These links are specific to
the version bundled with Rozh 0.2.0; verify and update them when upgrading the
FFmpeg packages. Rozh's MIT license does not replace or override any
third-party license.

## Noto Naskh Arabic

Rozh ships the "Noto Naskh Arabic" font (`resources/fonts/NotoNaskhArabic.ttf`)
only as a last-resort source of Arabic/Sorani-Kurdish glyphs for burned-in
subtitles, used when neither the font a subtitle asks for nor anything
installed on the user's device has the letters. It is never forced onto a
subtitle: burned-in text uses the font named in the subtitle file, resolved
against the user's own installed fonts. It is Copyright 2022 The Noto
Project Authors and licensed under the **SIL Open Font License, Version
1.1** — see `resources/fonts/OFL.txt` for the full text. The OFL permits
bundling and redistribution (including in a commercial app) as long as the
font isn't sold on its own and the license file travels with it, both of
which are satisfied here.

## Other dependencies

Rozh also depends on Electron, React, Vite, and other packages listed in
`package.json`, each under its own (generally MIT/Apache-2.0/BSD-style)
license. Run `npx license-checker --summary` after `npm install` to generate a
full dependency license report before distributing a release build.
