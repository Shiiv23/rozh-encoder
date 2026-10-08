// Runs in a sandboxed preload: it may only require 'electron', so every other import here must be type-only.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { EncodeSettings, MenuCommand, MenuState, ProgressInfo, RozhApi } from './types';

const api: RozhApi = {
  appInfo: () => ipcRenderer.invoke('app:info'),
  ffmpegStatus: () => ipcRenderer.invoke('ffmpeg:status'),
  locateFfmpeg: () => ipcRenderer.invoke('ffmpeg:locate'),
  resetFfmpeg: () => ipcRenderer.invoke('ffmpeg:reset'),
  openMediaDialog: () => ipcRenderer.invoke('dialog:openMedia'),
  openSubtitleDialog: () => ipcRenderer.invoke('dialog:openSubtitle'),
  openImageDialog: () => ipcRenderer.invoke('dialog:openImage'),
  chooseOutputFolder: () => ipcRenderer.invoke('dialog:outputFolder'),
  chooseOutputFile: (defaultName, container, defaultDir) => ipcRenderer.invoke('dialog:outputFile', defaultName, container, defaultDir),
  planOutput: request => ipcRenderer.invoke('output:plan', request),
  inspect: file => ipcRenderer.invoke('media:inspect', file),
  start: (jobId: string, settings: EncodeSettings) => ipcRenderer.invoke('encode:start', jobId, settings),
  cancel: jobId => ipcRenderer.invoke('encode:cancel', jobId),
  previewSubtitle: (settings: EncodeSettings, atSec?: number) => ipcRenderer.invoke('preview:subtitle', settings, atSec),
  onProgress: listener => {
    const handler = (_event: unknown, jobId: string, info: ProgressInfo) => listener(jobId, info);
    ipcRenderer.on('encode:progress', handler);
    return () => { ipcRenderer.removeListener('encode:progress', handler); };
  },
  readLog: logPath => ipcRenderer.invoke('log:read', logPath),
  openLogFolder: () => ipcRenderer.invoke('log:openFolder'),
  listLogs: () => ipcRenderer.invoke('log:list'),
  clearLogs: () => ipcRenderer.invoke('log:clear'),
  notify: options => ipcRenderer.invoke('notify:show', options),
  showInFolder: file => ipcRenderer.invoke('file:showInFolder', file),
  pathsFromFiles: files => files.map(file => webUtils.getPathForFile(file)).filter(Boolean),
  setMenuState: (state: MenuState) => ipcRenderer.send('menu:state', state),
  onMenuCommand: listener => {
    const handler = (_event: unknown, command: MenuCommand) => listener(command);
    ipcRenderer.on('menu:command', handler);
    return () => { ipcRenderer.removeListener('menu:command', handler); };
  }
};

contextBridge.exposeInMainWorld('rozh', api);
