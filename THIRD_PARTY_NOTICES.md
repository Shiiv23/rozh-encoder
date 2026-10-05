# Third-Party Notices

Rozh's own source code is licensed under the MIT License (see `LICENSE`).
Rozh bundles the following third-party components, which are licensed
separately and are **not** covered by the MIT License above.

## FFmpeg / FFprobe

Rozh ships prebuilt `ffmpeg` and `ffprobe` binaries (via the `ffmpeg-static`
and `ffprobe-static` npm packages, which redistribute gyan.dev's Windows
"essentials" builds and equivalent static builds for macOS/Linux) and invokes
them as a separate process — Rozh does not link against FFmpeg's libraries.

FFmpeg is Copyright © 2000–2024 the FFmpeg developers. The `ffmpeg-static`
binaries Rozh bundles are built with `libx264`/`libx265` (H.264/H.265
encoding), which are GPL-licensed, so the resulting binary as a whole is
licensed under the **GNU General Public License version 2 or later
(GPL-2.0+)** rather than the plain LGPL. (The `ffmpeg-static` npm wrapper
package itself is also GPL-3.0-or-later.)

Because Rozh redistributes these binaries, Rozh's own maintainers must:

1. **Include this notice and the applicable license text** with every
   distributed copy of Rozh. See `licenses/ffmpeg-LICENSE.md` for the full
   GPL-2.0/LGPL-2.1 text (fill in with the license file shipped inside your
   specific `ffmpeg-static`/`ffprobe-static` version — see
   `node_modules/ffmpeg-static` and `node_modules/ffprobe-static` after
   `npm install`).
2. **Make the corresponding FFmpeg source code available** to anyone who
   receives a binary copy of Rozh, for as long as Rozh is distributed. Rozh's
   bundled binaries come from `ffmpeg-static@5.3.0` / `ffprobe-static@3.1.0`,
   which currently resolve to **FFmpeg 6.1.1**, built from the exact source
   and build scripts published at
   <https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1>. That
   release page is the "written offer" — link to it (or the matching tag for
   whatever `ffmpeg-static` version you're actually shipping) from your
   release notes/about page. **If you upgrade `ffmpeg-static`/`ffprobe-static`
   later, update this version number and link to match**, since the offer
   must point at the source for the binary you actually ship.
3. Not misrepresent Rozh itself as covered by FFmpeg's license, and not
   claim FFmpeg is covered by Rozh's MIT license.

Rozh links to <https://ffmpeg.org/legal.html> and credits FFmpeg in its
in-app About panel (Help/Rozh → Licenses / About Rozh), but that in-app
notice alone is not sufficient for GPL/LGPL compliance — the written offer
in point 2 above is still required.

## Noto Naskh Arabic

Rozh ships the "Noto Naskh Arabic" font (`resources/fonts/NotoNaskhArabic.ttf`)
only as a last-resort source of Arabic/Sorani-Kurdish glyphs for burned-in
subtitles, used when neither the font a subtitle asks for nor anything
installed on the user's device has the letters. It is never forced onto a
subtitle: burned-in text uses the font named in the subtitle file, resolved
against the user's own installed fonts. It is Copyright © 2022 The Noto
Project Authors and licensed under the **SIL Open Font License, Version
1.1** — see `resources/fonts/OFL.txt` for the full text. The OFL permits
bundling and redistribution (including in a commercial app) as long as the
font isn't sold on its own and the license file travels with it, both of
which are satisfied here.

## Other dependencies

Rozh also depends on Electron, React, Vite, and other packages listed in
`package.json`, each under its own (generally MIT/Apache-2.0/BSD-style)
license. Run `npx license-checker --summary` after `npm install` to generate
a full dependency license report before distributing a release build.
