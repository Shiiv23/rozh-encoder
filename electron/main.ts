import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { bundledArabicFontsDir } from './bundledFont';
import { bundledFfmpeg, bundledFfprobe } from './bundledBinaries';
import { clearLogFiles, isInside, listLogFiles, loadConfig, saveConfig, writeLogFile } from './config';
import { EncodeService } from './encodeService';
import { buildMenuTemplate, EMPTY_MENU_STATE } from './menu';
import { detectFfmpeg, inspectMedia, renderSubtitlePreview, setFallbackFontsDir, setBinaryOverrides, setBundledBinaries, startEncoding } from './media';
import { basename, dirname, isAbsolutePath, pathKey, uniqueOutputPath } from './paths';
import { CONTAINER_INFO, EXTERNAL_SUBTITLE_EXTENSIONS } from './rules';
import type { AppInfo, Container, EncodeSettings, FfmpegStatus, MenuCommand, MenuState, SubtitlePreviewResult } from './types';

app.disableHardwareAcceleration();

const isDev = process.argv.includes('--dev');
let win: BrowserWindow | null = null;
let menuState: MenuState = EMPTY_MENU_STATE;

const configDir = () => app.getPath('userData');
const logDir = () => path.join(app.getPath('userData'), 'logs');

app.setAboutPanelOptions({
  applicationName: 'Rozh Encoder',
  applicationVersion: app.getVersion(),
  copyright: 'Copyright © Abdulaziz Azeez',
  credits: [
    'This application uses FFmpeg (gyan.dev essentials build).',
    'FFmpeg Copyright © 2000–2024 the FFmpeg developers.',
    'FFmpeg is licensed under the LGPL/GPL; Rozh is licensed under the MIT License.',
    'See THIRD_PARTY_NOTICES.md (bundled with this app) for full license details.',
    'https://ffmpeg.org/legal.html'
  ].join('\n'),
  website: 'https://ffmpeg.org/'
});

const service = new EncodeService({
  detect: detectFfmpeg,
  inspect: inspectMedia,
  startEncoding,
  writeLog: (jobId, text) => writeLogFile(logDir(), jobId, text).catch(() => undefined)
});

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function applyMenu(): void {
  const send = (command: MenuCommand) => sendToRenderer('menu:command', command);
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(menuState, send, process.platform === 'darwin', app.name)));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 660,
    title: 'Rozh',
    backgroundColor: '#e9ebee',
    icon: path.join(__dirname, '../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  // The renderer never needs a real new window, but it does open a couple of
  // external help links (e.g. Help -> Installing FFmpeg) via window.open(),
  // which also routes through this handler. Send https/http URLs out to the
  // user's default browser instead of silently swallowing them, and still
  // deny everything else (no in-app popups).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', event => {
    if (!isDev || !event.url.startsWith('http://localhost:5173')) event.preventDefault();
  });
  if (isDev) void win.loadURL('http://localhost:5173');
  else void win.loadFile(path.join(__dirname, '../dist/index.html'));
  win.on('closed', () => { win = null; });
}

// A close request while encoding would orphan FFmpeg; ask first.
function guardClose(): void {
  app.on('before-quit', event => {
    if (!service.busy) return;
    const answer = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Keep encoding', 'Quit and cancel'],
      defaultId: 0,
      cancelId: 0,
      message: 'An encode is still running.',
      detail: 'Quitting will cancel it and discard the unfinished file.'
    });
    if (answer === 0) event.preventDefault();
  });
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function registerIpc(): void {
  ipcMain.handle('app:info', (): AppInfo => ({ version: app.getVersion(), platform: process.platform, logDir: logDir() }));
  ipcMain.handle('ffmpeg:status', () => detectFfmpeg());

  ipcMain.handle('ffmpeg:locate', async (): Promise<FfmpegStatus | undefined> => {
    const chosen = await dialog.showOpenDialog(win!, {
      title: 'Locate the ffmpeg executable',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'ffmpeg.exe', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }] : [{ name: 'All files', extensions: ['*'] }]
    });
    const ffmpeg = chosen.filePaths[0];
    if (chosen.canceled || !ffmpeg) return undefined;
    const exe = process.platform === 'win32' ? '.exe' : '';
    const sibling = path.join(path.dirname(ffmpeg), `ffprobe${exe}`);
    setBinaryOverrides({ ffmpeg, ffprobe: fs.existsSync(sibling) ? sibling : undefined });
    await saveConfig(configDir(), { ffmpeg, ffprobe: fs.existsSync(sibling) ? sibling : undefined });
    return detectFfmpeg();
  });

  ipcMain.handle('ffmpeg:reset', async (): Promise<FfmpegStatus> => {
    setBinaryOverrides({});
    await saveConfig(configDir(), {});
    return detectFfmpeg();
  });

  ipcMain.handle('dialog:openMedia', async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog(win!, {
      title: 'Add video files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video files', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg', 'wmv', 'flv', 'ogv', '3gp'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('dialog:openSubtitle', async (): Promise<string | undefined> => {
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose a subtitle file',
      properties: ['openFile'],
      filters: [{ name: 'Subtitles', extensions: EXTERNAL_SUBTITLE_EXTENSIONS.map(e => e.slice(1)) }]
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle('dialog:openImage', async (): Promise<string | undefined> => {
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose a watermark logo',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle('dialog:outputFolder', async (): Promise<string | undefined> => {
    const result = await dialog.showOpenDialog(win!, { title: 'Choose the output folder', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle('dialog:outputFile', async (_e, defaultName: unknown, container: unknown, defaultDir: unknown) => {
    const kind = (str(container) in CONTAINER_INFO ? str(container) : 'mp4') as Container;
    const ext = CONTAINER_INFO[kind].ext;
    const dir = isAbsolutePath(str(defaultDir)) ? str(defaultDir) : undefined;
    const result = await dialog.showSaveDialog(win!, {
      title: 'Save encoded video as',
      defaultPath: dir ? path.join(dir, basename(str(defaultName))) : basename(str(defaultName)),
      filters: [{ name: CONTAINER_INFO[kind].label, extensions: [ext] }]
    });
    if (result.canceled || !result.filePath) return undefined;
    const file = result.filePath.toLowerCase().endsWith(`.${ext}`) ? result.filePath : `${result.filePath}.${ext}`;
    // The save dialog already asked the user to confirm replacing an existing file.
    return { path: file, exists: fs.existsSync(file) };
  });

  ipcMain.handle('output:plan', (_e, request: { input?: unknown; folder?: unknown; container?: unknown; taken?: unknown }) => {
    const input = str(request?.input);
    const kind = (str(request?.container) in CONTAINER_INFO ? str(request?.container) : 'mp4') as Container;
    const folder = isAbsolutePath(str(request?.folder)) ? str(request?.folder) : dirname(input);
    const taken = new Set((Array.isArray(request?.taken) ? request.taken : []).map(t => pathKey(str(t))));
    taken.add(pathKey(input));
    return uniqueOutputPath(folder, basename(input), CONTAINER_INFO[kind].ext, candidate => taken.has(pathKey(candidate)) || fs.existsSync(candidate));
  });

  ipcMain.handle('media:inspect', (_e, file: unknown) => inspectMedia(str(file)));

  ipcMain.handle('encode:start', (_e, jobId: unknown, settings: EncodeSettings) =>
    service.start(str(jobId), settings, info => sendToRenderer('encode:progress', str(jobId), info)));
  ipcMain.handle('encode:cancel', (_e, jobId: unknown) => service.cancel(str(jobId)));

  // One-frame subtitle preview. Cheap (about a second), so it may run alongside an encode.
  ipcMain.handle('preview:subtitle', async (_e, settings: EncodeSettings, atSec: unknown): Promise<SubtitlePreviewResult> => {
    if (!settings || !isAbsolutePath(str(settings.input))) return { status: 'failed', error: 'The file path must be absolute.' };
    const status = await detectFfmpeg();
    if (!status.available) return { status: 'failed', error: status.problem ?? 'FFmpeg is not available.' };
    return renderSubtitlePreview(settings, typeof atSec === 'number' && Number.isFinite(atSec) && atSec >= 0 ? atSec : undefined);
  });

  ipcMain.handle('log:read', async (_e, file: unknown) => {
    const target = str(file);
    if (!isInside(logDir(), target)) throw new Error('That file is not one of Rozh\'s logs.');
    return fs.promises.readFile(target, 'utf8');
  });
  ipcMain.handle('log:openFolder', async () => { await fs.promises.mkdir(logDir(), { recursive: true }); await shell.openPath(logDir()); });
  ipcMain.handle('log:list', () => listLogFiles(logDir()));
  ipcMain.handle('log:clear', () => clearLogFiles(logDir()));
  ipcMain.handle('file:showInFolder', (_e, file: unknown) => { if (isAbsolutePath(str(file))) shell.showItemInFolder(str(file)); });

  ipcMain.handle('notify:show', (_e, options: { title?: unknown; body?: unknown }) => {
    if (!Notification.isSupported()) return;
    new Notification({ title: str(options?.title) || 'Rozh Encoder', body: str(options?.body) }).show();
  });

  ipcMain.on('menu:state', (_e, state: MenuState) => { menuState = { ...EMPTY_MENU_STATE, ...state }; applyMenu(); });
}

// A crash in the main process would otherwise just kill the app with nothing
// written down, which is hard to debug from a user's bug report. Best-effort
// log it next to the per-job encode logs, then let the process die normally.
function logFatal(kind: string, error: unknown): void {
  const text = `[${new Date().toISOString()}] ${kind}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`;
  writeLogFile(logDir(), 'main-process-crash', text).catch(() => undefined);
  console.error(kind, error);
}
process.on('uncaughtException', error => logFatal('uncaughtException', error));
process.on('unhandledRejection', reason => logFatal('unhandledRejection', reason));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  guardClose();
  app.whenReady().then(async () => {
    setBundledBinaries({ ffmpeg: bundledFfmpeg, ffprobe: bundledFfprobe });
    setFallbackFontsDir(bundledArabicFontsDir);
    const stored = await loadConfig(configDir());
    setBinaryOverrides(stored);
    registerIpc();
    applyMenu();
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

