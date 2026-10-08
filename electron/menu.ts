import type { MenuItemConstructorOptions } from 'electron';
import type { MenuCommand, MenuState } from './types';

export const EMPTY_MENU_STATE: MenuState = {
  running: false, hasSelection: false, canRemove: false, canMoveUp: false, canMoveDown: false,
  canStartQueue: false, canEncodeSelected: false, canChooseOutputFile: false, canReset: false, hasFinished: false,
  notifyOnComplete: false, lang: 'en'
};

/**
 * Native menu bar. Every item sends a command to the renderer, which owns the queue and all
 * app state, and is enabled/checked only to match what it reports back in `state`. File covers
 * the queue and where its output goes, Encode covers running/stopping and per-run options, Tools
 * covers the FFmpeg binary and past logs.
 */
export function buildMenuTemplate(state: MenuState, send: (command: MenuCommand) => void, isMac: boolean, appName: string): MenuItemConstructorOptions[] {
  const item = (label: string, command: MenuCommand, enabled = true, accelerator?: string): MenuItemConstructorOptions =>
    ({ label, enabled, accelerator, click: () => send(command) });

  const checkbox = (label: string, command: MenuCommand, checked: boolean, enabled = true): MenuItemConstructorOptions =>
    ({ label, type: 'checkbox', checked, enabled, click: () => send(command) });

  const radio = (label: string, command: MenuCommand, checked: boolean): MenuItemConstructorOptions =>
    ({ label, type: 'radio', checked, click: () => send(command) });

  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        item('&Add Files…', 'add-files', true, 'CmdOrCtrl+O'),
        item('&Remove Selected', 'remove', state.canRemove),
        item('Move &Up', 'move-up', state.canMoveUp, 'CmdOrCtrl+Shift+Up'),
        item('Move &Down', 'move-down', state.canMoveDown, 'CmdOrCtrl+Shift+Down'),
        { type: 'separator' },
        item('Output &Folder…', 'choose-output-folder', !state.running),
        item('Output Fi&le for Selected…', 'choose-output-file', state.canChooseOutputFile),
        { type: 'separator' },
        item('&Clear Completed', 'clear-finished', state.hasFinished),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: '&Encode',
      submenu: [
        item('&Start Queue', 'start-queue', state.canStartQueue, 'CmdOrCtrl+Return'),
        item('Encode &Selected', 'encode-selected', state.canEncodeSelected, 'CmdOrCtrl+Shift+Return'),
        item('S&top', 'stop', state.running, 'CmdOrCtrl+.'),
        { type: 'separator' },
        item('&Reset Selected Job', 'reset', state.canReset),
        { type: 'separator' },
        checkbox('&Notify When Done', 'toggle-notify', state.notifyOnComplete)
      ]
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' }, { type: 'separator' },
        {
          label: '&Language',
          submenu: [
            radio('&English', 'set-lang-en', state.lang === 'en'),
            radio('&Kurdish (Sorani)', 'set-lang-ckb', state.lang === 'ckb')
          ]
        }
      ]
    },
    {
      label: '&Tools',
      submenu: [
        item('&Locate FFmpeg…', 'locate-ffmpeg', !state.running),
        item('&Use Bundled FFmpeg', 'reset-ffmpeg', !state.running),
        item('&Re-check FFmpeg', 'recheck-ffmpeg', !state.running),
        { type: 'separator' },
        item('&Encoder Logs', 'view-encoder-logs'),
        item('Open Logs &Folder', 'open-logs')
      ]
    },
    {
      label: '&Help',
      submenu: [item('&Installing FFmpeg', 'ffmpeg-help'), { type: 'separator' }, { role: 'about', label: '&Licenses / About Rozh' }]
    }
  ];
  if (isMac) template.unshift({ label: appName, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] });
  return template;
}
