// Pure string-based path helpers. They understand both Windows and POSIX paths regardless of the
// platform running them, so behaviour is identical in the app and in unit tests.
// No Node imports: the renderer uses these too.

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC = /^\\\\[^\\]/;

export function isWindowsPath(p: string): boolean {
  return WINDOWS_DRIVE.test(p) || WINDOWS_UNC.test(p);
}

export function isAbsolutePath(p: string): boolean {
  return isWindowsPath(p) || p.startsWith('/');
}

function separatorFor(p: string): '\\' | '/' {
  return isWindowsPath(p) ? '\\' : '/';
}

/** File name with extension. Handles both separators. */
export function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), isWindowsPath(p) ? trimmed.lastIndexOf('\\') : -1);
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

export function dirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), isWindowsPath(p) ? trimmed.lastIndexOf('\\') : -1);
  if (cut === -1) return '.';
  if (cut === 0) return trimmed.slice(0, 1);
  // Keep the root of "C:\file.mkv" as "C:\"
  if (cut === 2 && WINDOWS_DRIVE.test(trimmed)) return trimmed.slice(0, 3);
  return trimmed.slice(0, cut);
}

/** Extension including the dot, lower-cased. Empty for none. Dotfiles have no extension. */
export function extname(p: string): string {
  const name = basename(p);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

export function stem(p: string): string {
  const name = basename(p);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

export function joinPath(dir: string, name: string): string {
  const sep = separatorFor(dir);
  const base = dir.replace(/[\\/]+$/, '');
  // "C:" + "\" must keep its separator; "/" root likewise.
  return (base === '' ? '' : base) + sep + name;
}

/**
 * Normalised key for "is this the same file?" comparisons. Windows paths are case-insensitive and
 * accept both separators; Unicode is NFC-normalised so macOS-style decomposed names still match.
 */
export function pathKey(p: string): string {
  let out = p.normalize('NFC');
  const windows = isWindowsPath(out);
  if (windows) out = out.replace(/\//g, '\\');
  const sep = windows ? '\\' : '/';
  const isUnc = windows && out.startsWith('\\\\');
  const parts = out.split(sep);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (stack.length > 1 || (stack.length === 1 && !/^[A-Za-z]:$/.test(stack[0]))) stack.pop(); continue; }
    stack.push(part);
  }
  let joined = stack.join(sep);
  if (isUnc) joined = '\\\\' + joined;
  else if (!windows && p.startsWith('/')) joined = '/' + joined;
  return windows ? joined.toLowerCase() : joined;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/**
 * Picks `<stem>_Rozh.<ext>` in `dir`, adding " (2)", " (3)" … until `isTaken` says the name is free.
 * `isTaken` should cover files on disk and outputs already planned for other jobs.
 */
export function uniqueOutputPath(dir: string, sourceName: string, ext: string, isTaken: (candidate: string) => boolean, suffix = '_Rozh'): string {
  const base = `${stem(sourceName)}${suffix}`;
  let candidate = joinPath(dir, `${base}.${ext}`);
  for (let n = 2; isTaken(candidate) && n < 10_000; n++) candidate = joinPath(dir, `${base} (${n}).${ext}`);
  return candidate;
}

/** `<stem>.rozh-partial.<ext>` next to the final output. The muxer is still chosen by the real extension. */
export function partialPath(output: string): string {
  const ext = extname(output);
  return joinPath(dirname(output), `${stem(output)}.rozh-partial${ext}`);
}
