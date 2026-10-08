import path from 'node:path';
import { app } from 'electron';

/**
 * Rozh never chooses a subtitle font for the user. A burned-in subtitle is rendered with the font
 * its own file names (an .ass Style, an inline \\fn tag, an SRT <font face>), looked up among the
 * fonts installed on the user's device by libass — so every Arabic/Kurdish font the user has just
 * works, with no per-font setup.
 *
 * This directory holds Noto Naskh Arabic and Noto Sans Arabic (SIL OFL — see
 * resources/fonts/OFL.txt) as last-resort sources of Arabic/Sorani glyphs. If neither the
 * requested font nor anything installed on the machine has the letters (a bare Linux install,
 * say), libass can still find them here. These fonts are never forced onto a subtitle.
 *
 * Shipped via package.json's `extraResources` entry (`resources/fonts` -> `fonts`), so it lands next
 * to the packaged app's other resources rather than inside app.asar (libass needs a real directory).
 */
export const bundledArabicFontsDir: string = app.isPackaged
  ? path.join(process.resourcesPath, 'fonts')
  : path.join(app.getAppPath(), 'resources', 'fonts');
