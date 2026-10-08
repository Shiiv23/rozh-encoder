import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegStatic = require('ffmpeg-static') as string | null;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffprobeStatic = require('ffprobe-static') as { path: string };

/**
 * `ffmpeg-static`/`ffprobe-static` resolve to a path inside node_modules, which normally ends up
 * packed into `app.asar`. A packed archive can't exec a binary, so `package.json`'s `asarUnpack`
 * copies both packages next to the archive instead; this rewrites the in-asar path to that real
 * on-disk location. Outside a packaged app (dev, tests, `electron .`) there is no "app.asar" in the
 * path, so this is a no-op and the plain node_modules path is used as-is.
 */
function unpacked(p: string | null | undefined): string | undefined {
  if (!p) return undefined;
  const marker = `${path.sep}app.asar${path.sep}`;
  return p.includes(marker) ? p.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`) : p;
}

/** Absolute path to the FFmpeg binary Rozh ships with, or undefined on platforms with no static build. */
export const bundledFfmpeg = unpacked(ffmpegStatic);

/** Absolute path to the FFprobe binary Rozh ships with, or undefined on platforms with no static build. */
export const bundledFfprobe = unpacked(ffprobeStatic?.path);
