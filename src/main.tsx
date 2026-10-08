import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

import { basename, dirname } from '../electron/paths';
import {
  AUDIO_BITRATE_CHOICES, CODEC_INFO, CONTAINER_INFO, DEFAULT_AUDIO_KBPS, DEFAULT_SETTINGS, ENCODER_LABEL,
  FPS_CHOICES, QUALITY_ORDER, SHORT_EDGE_CHOICES, SUBTITLE_ENCODINGS, adjustForContainer, buildEncodeSettings,
  HW_BACKENDS, HW_LABEL, WATERMARK_POSITIONS, availableHardware, hardwareEncoderName, resolveHardware,
  crfFor, crfRange, defaultBurnStream, defaultKeepSubtitles, formatBitrate, formatBytes, formatDuration, formatFps,
  formatTimecode, parseTimecode, isBurnableEmbedded, parseFrameRate, resolveEncoder, selectableCodecs, streamLanguage,
  streamTitle, subtitleFitsContainer, validateEncode, validateGlobal, videoBitDepth
} from '../electron/rules';
import type {
  Container, EncodeSettings, FfmpegStatus, GlobalSettings, Issue, LogFileInfo, MediaInfo, MenuCommand, MenuState, ProgressInfo,
  HwAccelChoice, QualityPreset, SpeedPreset, SubtitlePreviewResult, VideoCodec, WatermarkPosition, WatermarkSettings
} from '../electron/types';
import { canMove, canRemove as jobCanRemove, canReset as jobCanReset, counts, isEditable, isStartable, queueReducer, type Job } from './queue';
import { QueueRunner } from './queueRunner';
import { LanguageProvider, LanguageSwitcher, useI18n } from './i18n';
import type { TKey } from './i18n';

let seq = 0;
const newId = () => `job-${Date.now()}-${++seq}`;

const NOTIFY_STORAGE_KEY = 'rozh:notify';
function loadNotifyPref(): boolean {
  try { return window.localStorage.getItem(NOTIFY_STORAGE_KEY) !== '0'; } catch { return true; }
}

export interface EncoderLogsState {
  files: LogFileInfo[];
  loading: boolean;
  error?: string;
  selected?: string;
  text?: string;
  textError?: string;
}
const EMPTY_ENCODER_LOGS: EncoderLogsState = { files: [], loading: false };

type TabKey = 'general' | 'video' | 'trim' | 'audio' | 'subtitles' | 'advanced' | 'log' | 'encoderLogs';

// -----------------------------------------------------------------------------------------------
// Small presentational helpers
// -----------------------------------------------------------------------------------------------

const STATUS_KEY: Record<Job['status'], TKey> = {
  pending: 'status.pending', analyzing: 'status.analyzing', ready: 'status.ready', encoding: 'status.encoding',
  complete: 'status.complete', failed: 'status.failed', cancelled: 'status.cancelled'
};

function StatusBadge({ status }: { status: Job['status'] }) {
  const { t } = useI18n();
  return <span className={`badge badge-${status}`}>{t(STATUS_KEY[status])}</span>;
}

function ProgressCell({ job }: { job: Job }) {
  if (job.status === 'encoding') {
    const p = job.progress?.percent;
    return (
      <div className="progress-cell">
        <div className="progress-track">
          <div className={`progress-fill${p === undefined ? ' indeterminate' : ''}`} style={p === undefined ? undefined : { width: `${p}%` }} />
        </div>
        <span className="progress-text">{p === undefined ? '—' : `${p.toFixed(0)}%`}</span>
      </div>
    );
  }
  if (job.status === 'complete') return <div className="progress-cell"><div className="progress-track"><div className="progress-fill" style={{ width: '100%' }} /></div><span className="progress-text">100%</span></div>;
  return <span className="empty-hint">—</span>;
}

function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <div className="issues">
      {issues.map((iss, i) => <div key={i} className={`issue ${iss.level}`}>{iss.message}</div>)}
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// Root component
// -----------------------------------------------------------------------------------------------

function App() {
  const { t, lang, setLang } = useI18n();
  const [jobs, dispatch] = useReducer(queueReducer, [] as Job[]);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [settings, setSettings] = useState<GlobalSettings>(DEFAULT_SETTINGS);
  const [outputFolder, setOutputFolder] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<FfmpegStatus | undefined>(undefined);
  const [statusChecking, setStatusChecking] = useState(true);
  const [logDir, setLogDir] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<TabKey>('general');
  const [dragOver, setDragOver] = useState(false);
  const [running, setRunning] = useState(false);
  const [containerNotice, setContainerNotice] = useState<string | undefined>(undefined);
  const [openLog, setOpenLog] = useState<{ path: string; text?: string; error?: string } | undefined>(undefined);
  const [notifyOnComplete, setNotifyOnCompleteState] = useState<boolean>(loadNotifyPref);
  const [encoderLogs, setEncoderLogs] = useState<EncoderLogsState>(EMPTY_ENCODER_LOGS);

  const setNotifyOnComplete = useCallback((next: boolean) => {
    setNotifyOnCompleteState(next);
    try { window.localStorage.setItem(NOTIFY_STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  }, []);

  const runnerRef = useRef<QueueRunner | undefined>(undefined);
  const runSummaryRef = useRef({ complete: 0, failed: 0 });
  const stoppedRef = useRef(false);
  const encoders = status?.encoders ?? [];

  // ---- FFmpeg detection -----------------------------------------------------------------------
  const checkStatus = useCallback(async () => {
    setStatusChecking(true);
    try { setStatus(await window.rozh.ffmpegStatus()); } finally { setStatusChecking(false); }
  }, []);
  useEffect(() => {
    void checkStatus();
    void window.rozh.appInfo().then(info => setLogDir(info.logDir));
  }, [checkStatus]);

  // ---- Analyze newly added files ------------------------------------------------------------
  const analyze = useCallback(async (id: string, file: string) => {
    dispatch({ type: 'analyzing', id });
    try {
      const media = await window.rozh.inspect(file);
      dispatch({ type: 'analyzed', id, media });
    } catch (error) {
      dispatch({ type: 'analysisFailed', id, error: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const addFiles = useCallback((files: string[]) => {
    const existing = new Set(jobsRef.current.map(j => j.input));
    const fresh = files.filter(f => f && !existing.has(f)).map(f => ({ id: newId(), input: f }));
    if (!fresh.length) return;
    dispatch({ type: 'add', items: fresh });
    if (!selectedId) setSelectedId(fresh[0].id);
    for (const item of fresh) void analyze(item.id, item.input);
  }, [analyze, selectedId]);

  const addFilesDialog = useCallback(async () => addFiles(await window.rozh.openMediaDialog()), [addFiles]);

  // ---- Drag & drop -----------------------------------------------------------------------------
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const paths = window.rozh.pathsFromFiles(Array.from(e.dataTransfer.files));
    addFiles(paths);
  }, [addFiles]);

  // ---- Output planning: fill in automatic output paths whenever jobs/settings/folder change ---
  useEffect(() => {
    const need = jobs.filter(j => !j.outputChosen && isEditable(j) && j.status !== 'complete' && !j.output);
    if (!need.length) return;
    let cancelled = false;
    void (async () => {
      const taken = new Set(jobs.map(j => j.output).filter(Boolean) as string[]);
      const outputs: Record<string, string> = {};
      for (const job of need) {
        const folder = outputFolder ?? dirname(job.input);
        const path = await window.rozh.planOutput({ input: job.input, folder, container: settings.container, taken: [...taken] });
        outputs[job.id] = path;
        taken.add(path);
      }
      if (!cancelled) dispatch({ type: 'setPlanned', outputs });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs.length, outputFolder, settings.container]);

  // Re-plan (drop the user's chosen output) when the container changes, since the extension no longer matches.
  const prevContainer = useRef(settings.container);
  useEffect(() => {
    if (prevContainer.current !== settings.container) {
      dispatch({ type: 'unchooseOutputs', ids: jobsRef.current.filter(j => j.outputChosen && isEditable(j)).map(j => j.id) });
      prevContainer.current = settings.container;
    }
  }, [settings.container]);

  // ---- Selected job / derived state -------------------------------------------------------------
  const selected = jobs.find(j => j.id === selectedId);
  const selectedMedia = selected?.media;

  useEffect(() => {
    // Keep the codec valid whenever the encoder list or container changes.
    if (encoders.length && !resolveEncoder(settings.codec, encoders)) {
      const fallback = selectableCodecs(settings.container, encoders)[0];
      if (fallback) setSettings(s => ({ ...s, codec: fallback }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const globalIssues = useMemo(() => validateGlobal(settings, status?.available ? encoders : undefined), [settings, status]);

  const encodeSettingsFor = useCallback((job: Job): ReturnType<typeof buildEncodeSettings> | undefined => {
    if (!job.output) return undefined;
    return buildEncodeSettings(settings, job.input, job.output, job.overwrite, {
      media: job.media, externalSubtitle: job.externalSubtitle, keepSubtitles: job.keepSubtitles, burnStream: job.burnStream,
      trimStartSec: job.trimStartSec, trimEndSec: job.trimEndSec
    }, encoders);
  }, [settings, encoders]);

  // Same settings an encode would use. The preview never writes an output file, so a missing output path is fine.
  const previewSettingsFor = useCallback((job: Job) => buildEncodeSettings(settings, job.input, job.output ?? `${job.input}.preview`, false, {
    media: job.media, externalSubtitle: job.externalSubtitle, keepSubtitles: job.keepSubtitles, burnStream: job.burnStream,
    trimStartSec: job.trimStartSec, trimEndSec: job.trimEndSec
  }, encoders), [settings, encoders]);

  const selectedEncodeSettings = selected ? encodeSettingsFor(selected) : undefined;
  const selectedIssues = useMemo(
    () => (selected && selectedEncodeSettings ? validateEncode(selectedEncodeSettings, selectedMedia, status?.available ? encoders : undefined) : []),
    [selected, selectedEncodeSettings, selectedMedia, status, encoders]
  );

  // ---- Queue runner -----------------------------------------------------------------------------
  useEffect(() => {
    runnerRef.current = new QueueRunner({
      getJobs: () => jobsRef.current,
      runJob: async job => {
        const es = encodeSettingsFor(job);
        if (!es) return { status: 'failed', error: 'No output location was set for this file.' };
        return window.rozh.start(job.id, es);
      },
      cancelJob: id => { void window.rozh.cancel(id); },
      onStart: id => dispatch({ type: 'encoding', id }),
      onResult: (id, result) => {
        dispatch({ type: 'finished', id, result });
        if (result.status === 'complete') runSummaryRef.current.complete++;
        else if (result.status === 'failed') runSummaryRef.current.failed++;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encodeSettingsFor]);

  useEffect(() => {
    const off = window.rozh.onProgress((id, info: ProgressInfo) => dispatch({ type: 'progress', id, info }));
    return off;
  }, []);

  const pollRunning = useCallback(() => setRunning(!!runnerRef.current?.running), []);
  useEffect(() => {
    const t = setInterval(pollRunning, 150);
    return () => clearInterval(t);
  }, [pollRunning]);

  // ---- Notifications -----------------------------------------------------------------------------
  const notifyRunFinished = useCallback(() => {
    if (!notifyOnComplete || stoppedRef.current) return;
    const { complete, failed } = runSummaryRef.current;
    const total = complete + failed;
    if (!total) return;
    const body = total === 1 ? (failed ? t('notify.oneFailed') : t('notify.oneComplete')) : t('notify.summary', { complete, failed });
    void window.rozh.notify({ title: t('notify.title'), body });
  }, [notifyOnComplete, t]);

  const startQueue = useCallback(async () => {
    stoppedRef.current = false;
    runSummaryRef.current = { complete: 0, failed: 0 };
    await runnerRef.current?.run({ kind: 'queue' });
    pollRunning();
    notifyRunFinished();
  }, [pollRunning, notifyRunFinished]);
  const startSelected = useCallback(async () => {
    if (!selectedId) return;
    stoppedRef.current = false;
    runSummaryRef.current = { complete: 0, failed: 0 };
    await runnerRef.current?.run({ kind: 'single', id: selectedId });
    pollRunning();
    notifyRunFinished();
  }, [selectedId, pollRunning, notifyRunFinished]);
  const stopQueue = useCallback(() => { stoppedRef.current = true; runnerRef.current?.stop(); pollRunning(); }, [pollRunning]);

  // ---- Toolbar actions ---------------------------------------------------------------------------
  const removeSelected = useCallback(() => { if (selectedId) dispatch({ type: 'remove', id: selectedId }); }, [selectedId]);
  const moveSelected = useCallback((delta: -1 | 1) => { if (selectedId) dispatch({ type: 'move', id: selectedId, delta }); }, [selectedId]);
  const resetSelected = useCallback(() => { if (selectedId) dispatch({ type: 'reset', id: selectedId }); }, [selectedId]);
  const clearCompleted = useCallback(() => dispatch({ type: 'clearCompleted' }), []);

  const chooseOutputFolder = useCallback(async () => {
    const folder = await window.rozh.chooseOutputFolder();
    if (folder) { setOutputFolder(folder); dispatch({ type: 'unchooseOutputs', ids: jobsRef.current.filter(isEditable).map(j => j.id) }); }
  }, []);

  const chooseOutputFileForSelected = useCallback(async () => {
    if (!selected) return;
    const picked = await window.rozh.chooseOutputFile(basename(selected.input), settings.container, outputFolder ?? dirname(selected.input));
    if (picked) dispatch({ type: 'setOutput', id: selected.id, output: picked.path, chosen: true, overwrite: picked.exists });
  }, [selected, settings.container, outputFolder]);

  const locateFfmpeg = useCallback(async () => {
    const next = await window.rozh.locateFfmpeg();
    if (next) setStatus(next);
  }, []);

  const resetFfmpeg = useCallback(async () => {
    setStatus(await window.rozh.resetFfmpeg());
  }, []);

  const viewLog = useCallback(async () => {
    if (!selected?.logPath) return;
    setTab('log');
    try { setOpenLog({ path: selected.logPath, text: await window.rozh.readLog(selected.logPath) }); }
    catch (error) { setOpenLog({ path: selected.logPath, error: error instanceof Error ? error.message : String(error) }); }
  }, [selected]);

  // ---- Encoder Logs tab (app-wide, every log Rozh has written) -----------------------------------
  const refreshEncoderLogs = useCallback(async () => {
    setEncoderLogs(p => ({ ...p, loading: true, error: undefined }));
    try {
      const files = await window.rozh.listLogs();
      setEncoderLogs(p => ({ ...p, files, loading: false }));
    } catch (error) {
      setEncoderLogs(p => ({ ...p, loading: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }, []);

  useEffect(() => { if (tab === 'encoderLogs') void refreshEncoderLogs(); }, [tab, refreshEncoderLogs]);

  const viewEncoderLogFile = useCallback(async (file: string) => {
    setEncoderLogs(p => ({ ...p, selected: file, text: undefined, textError: undefined }));
    try {
      const text = await window.rozh.readLog(file);
      setEncoderLogs(p => (p.selected === file ? { ...p, text } : p));
    } catch (error) {
      setEncoderLogs(p => (p.selected === file ? { ...p, textError: error instanceof Error ? error.message : String(error) } : p));
    }
  }, []);

  const clearAllEncoderLogs = useCallback(async () => {
    await window.rozh.clearLogs();
    setEncoderLogs(EMPTY_ENCODER_LOGS);
    void refreshEncoderLogs();
  }, [refreshEncoderLogs]);

  // ---- Native menu wiring -------------------------------------------------------------------------
  const menuState: MenuState = useMemo(() => ({
    running,
    hasSelection: !!selected,
    canRemove: !!selected && jobCanRemove(selected),
    canMoveUp: !!selectedId && canMove(jobs, selectedId, -1),
    canMoveDown: !!selectedId && canMove(jobs, selectedId, 1),
    canStartQueue: !running && jobs.some(isStartable),
    canEncodeSelected: !running && !!selected && isStartable(selected),
    canChooseOutputFile: !!selected && isEditable(selected),
    canReset: !!selected && jobCanReset(selected),
    hasFinished: jobs.some(j => j.status === 'complete'),
    notifyOnComplete,
    lang
  }), [running, selected, selectedId, jobs, notifyOnComplete, lang]);

  useEffect(() => window.rozh.setMenuState(menuState), [menuState]);

  useEffect(() => window.rozh.onMenuCommand((command: MenuCommand) => {
    switch (command) {
      case 'add-files': void addFilesDialog(); break;
      case 'remove': removeSelected(); break;
      case 'move-up': moveSelected(-1); break;
      case 'move-down': moveSelected(1); break;
      case 'clear-finished': clearCompleted(); break;
      case 'reset': resetSelected(); break;
      case 'choose-output-folder': void chooseOutputFolder(); break;
      case 'choose-output-file': void chooseOutputFileForSelected(); break;
      case 'start-queue': void startQueue(); break;
      case 'encode-selected': void startSelected(); break;
      case 'stop': stopQueue(); break;
      case 'locate-ffmpeg': void locateFfmpeg(); break;
      case 'reset-ffmpeg': void resetFfmpeg(); break;
      case 'recheck-ffmpeg': void checkStatus(); break;
      case 'toggle-notify': setNotifyOnComplete(!notifyOnComplete); break;
      case 'view-encoder-logs': setTab('encoderLogs'); break;
      case 'open-logs': void window.rozh.openLogFolder(); break;
      case 'set-lang-en': setLang('en'); break;
      case 'set-lang-ckb': setLang('ckb'); break;
      case 'ffmpeg-help': window.open('https://ffmpeg.org/download.html'); break;
      case 'about': break;
    }
  }), [addFilesDialog, removeSelected, moveSelected, clearCompleted, resetSelected, chooseOutputFolder, chooseOutputFileForSelected, startQueue, startSelected, stopQueue, locateFfmpeg, resetFfmpeg, checkStatus, notifyOnComplete, setNotifyOnComplete, setLang]);

  // ---- Settings mutation helpers -----------------------------------------------------------------
  const setContainer = useCallback((container: Container) => {
    const { settings: next, notes } = adjustForContainer(settings, container, encoders.length ? encoders : CODEC_INFO[settings.codec].encoders);
    setSettings(next);
    setContainerNotice(notes.join(' '));
    if (notes.length) setTimeout(() => setContainerNotice(undefined), 6000);
  }, [settings, encoders]);

  const activeCount = jobs.filter(j => j.status === 'encoding' || j.status === 'pending' || j.status === 'analyzing' || j.status === 'ready').length;
  const jobCounts = counts(jobs);
  const current = jobs.find(j => j.status === 'encoding');

  return (
    <div className="app">
      <TitleBar current={current} outputFolder={outputFolder} />
      {status && !status.available && <FfmpegBanner status={status} checking={statusChecking} onLocate={locateFfmpeg} onReset={resetFfmpeg} onRecheck={checkStatus} />}
      <Ribbon
        selected={selected} running={running} jobs={jobs} selectedId={selectedId}
        onAdd={addFilesDialog} onRemove={removeSelected} onUp={() => moveSelected(-1)} onDown={() => moveSelected(1)}
        onStartQueue={startQueue} onStartSelected={startSelected} onStop={stopQueue}
        onOutputFolder={chooseOutputFolder} onOutputFile={chooseOutputFileForSelected}
        onReset={resetSelected} onClearCompleted={clearCompleted} onLocate={locateFfmpeg}
        canStartQueue={menuState.canStartQueue} canStartSelected={menuState.canEncodeSelected}
      />
      <div className="body">
        <div className="pane-left">
          <div className="section-label">{t('queue.batchQueue')} {jobs.length ? t('queue.pendingReady', { active: activeCount, done: jobCounts.complete }) : ''}</div>
          <div className={`queue-drop${dragOver ? ' dragover' : ''}`}
               onDragOver={e => { e.preventDefault(); setDragOver(true); }}
               onDragLeave={() => setDragOver(false)}
               onDrop={onDrop}>
            <div className="queue-scroll">
              <QueueTable jobs={jobs} selectedId={selectedId} onSelect={setSelectedId} onAddFiles={addFilesDialog} />
            </div>
          </div>
        </div>
        <div className="pane-right">
          <Tabs tab={tab} setTab={setTab} hasLog={!!selected?.logPath} hasError={selected?.status === 'failed'} />
          <div className="tab-content">
            {tab === 'general' && (
              <GeneralTab settings={settings} setSettings={setSettings} setContainer={setContainer}
                          containerNotice={containerNotice} outputFolder={outputFolder} onChooseFolder={chooseOutputFolder}
                          globalIssues={globalIssues} selected={selected} selectedIssues={selectedIssues}
                          notifyOnComplete={notifyOnComplete} onSetNotifyOnComplete={setNotifyOnComplete} />
            )}
            {tab === 'video' && <VideoTab settings={settings} setSettings={setSettings} encoders={encoders} media={selectedMedia} />}
            {tab === 'trim' && <TrimTab selected={selected} dispatch={dispatch} />}
            {tab === 'audio' && <AudioTab settings={settings} setSettings={setSettings} media={selectedMedia} />}
            {tab === 'subtitles' && (
              <SubtitlesTab settings={settings} setSettings={setSettings} selected={selected} dispatch={dispatch} previewSettingsFor={previewSettingsFor} />
            )}
            {tab === 'advanced' && <AdvancedTab selected={selected} status={status} />}
            {tab === 'log' && <LogTab selected={selected} openLog={openLog} onView={viewLog} />}
            {tab === 'encoderLogs' && (
              <EncoderLogsTab state={encoderLogs} onRefresh={refreshEncoderLogs} onView={viewEncoderLogFile}
                               onOpenFolder={() => window.rozh.openLogFolder()} onClearAll={clearAllEncoderLogs} />
            )}
          </div>
        </div>
      </div>
      <StatusBar status={status} checking={statusChecking} onRecheck={checkStatus} onLocate={locateFfmpeg}
                 current={current} jobs={jobs} logDir={logDir} />
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// Title bar / banner / status bar
// -----------------------------------------------------------------------------------------------

function TitleBar({ current, outputFolder }: { current?: Job; outputFolder?: string }) {
  const { t } = useI18n();
  return (
    <div className="titlebar">
      <span className="mark">{t('brand.mark')}</span>
      <span className="sep">·</span>
      <span>{t('brand.tagline')}</span>
      <span className="spacer" />
      {current && <span className="path">{t('titlebar.encoding', { name: current.name })}</span>}
      {!current && outputFolder && <span className="path">{t('titlebar.outputFolder', { folder: outputFolder })}</span>}
      <LanguageSwitcher />
    </div>
  );
}

function FfmpegBanner({ status, checking, onLocate, onReset, onRecheck }: { status: FfmpegStatus; checking: boolean; onLocate: () => void; onReset: () => void; onRecheck: () => void }) {
  const { t } = useI18n();
  return (
    <div className="banner">
      <strong>{t('banner.unavailable')}</strong>
      <span>{status.problem ?? t('banner.defaultProblem')}</span>
      <button className="btn small" onClick={onRecheck} disabled={checking}>{checking ? t('banner.checking') : t('banner.recheck')}</button>
      <button className="btn small" onClick={onReset}>{t('banner.useBundled')}</button>
      <button className="btn small primary" onClick={onLocate}>{t('banner.locate')}</button>
    </div>
  );
}

function StatusBar({ status, checking, onRecheck, onLocate, current, jobs, logDir }: {
  status?: FfmpegStatus; checking: boolean; onRecheck: () => void; onLocate: () => void; current?: Job; jobs: Job[]; logDir?: string;
}) {
  const { t } = useI18n();
  const dot = !status ? 'dot-warn' : status.available ? 'dot-ok' : 'dot-bad';
  const label = !status ? (checking ? t('statusbar.checking') : t('statusbar.unknown')) : status.available
    ? t('statusbar.ready', { count: status.encoders.length })
    : t('statusbar.unavailable');
  return (
    <div className="statusbar">
      <span><span className={`dot ${dot}`} />{label}</span>
      {!status?.available && <button className="link" onClick={onLocate}>{t('statusbar.locate')}</button>}
      <button className="link" onClick={onRecheck} disabled={checking}>{t('statusbar.recheck')}</button>
      <span className="spacer" />
      {current?.progress && (
        <span>
          {current.progress.speed ? `${current.progress.speed.toFixed(2)}x` : ''}
          {current.progress.fps ? ` · ${current.progress.fps.toFixed(0)} fps` : ''}
          {current.progress.etaSec !== undefined ? ` · ${t('statusbar.eta', { time: formatDuration(current.progress.etaSec) })}` : ''}
        </span>
      )}
      <span>{t('statusbar.filesInQueue' as TKey, { count: jobs.length })}</span>
      {logDir && <button className="link" onClick={() => window.rozh.openLogFolder()}>{t('statusbar.logs')}</button>}
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// Ribbon
// -----------------------------------------------------------------------------------------------

function Ribbon(props: {
  selected?: Job; running: boolean; jobs: Job[]; selectedId?: string;
  onAdd: () => void; onRemove: () => void; onUp: () => void; onDown: () => void;
  onStartQueue: () => void; onStartSelected: () => void; onStop: () => void;
  onOutputFolder: () => void; onOutputFile: () => void;
  onReset: () => void; onClearCompleted: () => void; onLocate: () => void;
  canStartQueue: boolean; canStartSelected: boolean;
}) {
  const { t } = useI18n();
  const { selected, running, jobs, selectedId } = props;
  const btn = (icon: string, label: string, onClick: () => void, disabled: boolean, extra = '') => (
    <button className={`rbtn ${extra}`} onClick={onClick} disabled={disabled} title={label}>
      <span className="ico">{icon}</span><span>{label}</span>
    </button>
  );
  return (
    <div className="ribbon">
      <div className="ribbon-group">
        {btn('＋', t('ribbon.addFiles'), props.onAdd, false)}
        {btn('✕', t('ribbon.remove'), props.onRemove, !selected || !jobCanRemove(selected))}
        {btn('▲', t('ribbon.moveUp'), props.onUp, !selectedId || !canMove(jobs, selectedId, -1))}
        {btn('▼', t('ribbon.moveDown'), props.onDown, !selectedId || !canMove(jobs, selectedId, 1))}
      </div>
      <div className="ribbon-group">
        {btn('▶', t('ribbon.startQueue'), props.onStartQueue, !props.canStartQueue, 'primary')}
        {btn('▶︎', t('ribbon.encodeSelected'), props.onStartSelected, !props.canStartSelected)}
        {btn('■', t('ribbon.stop'), props.onStop, !running, 'danger')}
        {btn('↺', t('ribbon.resetJob'), props.onReset, !selected || !jobCanReset(selected))}
      </div>
      <div className="ribbon-group">
        {btn('📁', t('ribbon.outputFolder'), props.onOutputFolder, false)}
        {btn('📄', t('ribbon.outputFile'), props.onOutputFile, !selected || !isEditable(selected))}
        {btn('🧹', t('ribbon.clearDone'), props.onClearCompleted, !jobs.some(j => j.status === 'complete'))}
      </div>
      <div className="ribbon-group">
        {btn('🔧', t('ribbon.locateFfmpeg'), props.onLocate, false)}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// Queue table
// -----------------------------------------------------------------------------------------------

function QueueTable({ jobs, selectedId, onSelect, onAddFiles }: { jobs: Job[]; selectedId?: string; onSelect: (id: string) => void; onAddFiles: () => void }) {
  const { t } = useI18n();
  if (!jobs.length) {
    return (
      <div className="queue-empty">
        <div className="big">{t('queue.empty')}</div>
        <div>{t('queue.dragBefore')}<button style={{ border: 'none', background: 'none', color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline', padding: 0, font: 'inherit' }} onClick={onAddFiles}>{t('queue.addFilesLink')}</button>{t('queue.dragAfter')}</div>
      </div>
    );
  }
  return (
    <table className="queue">
      <thead>
        <tr><th style={{ width: 26 }}>{t('queue.colIndex')}</th><th>{t('queue.colName')}</th><th style={{ width: 90 }}>{t('queue.colStatus')}</th><th style={{ width: 150 }}>{t('queue.colProgress')}</th><th>{t('queue.colOutput')}</th></tr>
      </thead>
      <tbody>
        {jobs.map((job, i) => (
          <tr key={job.id} className={job.id === selectedId ? 'selected' : ''} onClick={() => onSelect(job.id)}>
            <td>{i + 1}</td>
            <td className="col-name" title={job.input}>
              <span className="name-line"><span className="file-icon">▦</span>{job.name}</span>
            </td>
            <td><StatusBadge status={job.status} />{job.status === 'failed' && job.error ? <div className="hint" style={{ marginTop: 2 }}>{job.error}</div> : null}</td>
            <td><ProgressCell job={job} /></td>
            <td className="col-out" title={job.output}>{job.output ? basename(job.output) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// -----------------------------------------------------------------------------------------------
// Tabs
// -----------------------------------------------------------------------------------------------

function Tabs({ tab, setTab, hasLog, hasError }: { tab: TabKey; setTab: (t: TabKey) => void; hasLog: boolean; hasError?: boolean }) {
  const { t } = useI18n();
  const items: Array<[TabKey, string]> = [
    ['general', t('tabs.general')], ['video', t('tabs.video')], ['trim', t('tabs.trim')],
    ['audio', t('tabs.audio')], ['subtitles', t('tabs.subtitles')], ['advanced', t('tabs.advanced')]
  ];
  return (
    <div className="tabs">
      {items.map(([k, label]) => <div key={k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</div>)}
      {(hasLog || hasError) && <div className={`tab${tab === 'log' ? ' active' : ''}`} onClick={() => setTab('log')}>{t('tabs.log')}{hasError ? ' ⚠' : ''}</div>}
      <div className={`tab${tab === 'encoderLogs' ? ' active' : ''}`} onClick={() => setTab('encoderLogs')}>{t('tabs.encoderLogs')}</div>
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// General tab: container, output, and the selected job's media info + issues
// -----------------------------------------------------------------------------------------------

function GeneralTab({ settings, setSettings, setContainer, containerNotice, outputFolder, onChooseFolder, globalIssues, selected, selectedIssues, notifyOnComplete, onSetNotifyOnComplete }: {
  settings: GlobalSettings; setSettings: React.Dispatch<React.SetStateAction<GlobalSettings>>; setContainer: (c: Container) => void;
  containerNotice?: string; outputFolder?: string; onChooseFolder: () => void; globalIssues: Issue[];
  selected?: Job; selectedIssues: Issue[]; notifyOnComplete: boolean; onSetNotifyOnComplete: (next: boolean) => void;
}) {
  void setSettings;
  const { t } = useI18n();
  return (
    <>
      <div className="group-title">{t('general.output')}</div>
      <div className="field-grid">
        <label>{t('general.container')}</label>
        <select value={settings.container} onChange={e => setContainer(e.target.value as Container)}>
          {(Object.keys(CONTAINER_INFO) as Container[]).map(c => <option key={c} value={c}>{CONTAINER_INFO[c].label}</option>)}
        </select>
        {containerNotice && <div className="hint">{containerNotice}</div>}

        <label>{t('general.outputFolder')}</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <div className="text-input" style={{ flex: 1, background: '#fff', color: outputFolder ? 'inherit' : 'var(--text-faint)' }}>
            {outputFolder ?? t('general.sameFolder')}
          </div>
          <button className="btn small" onClick={onChooseFolder}>{t('general.choose')}</button>
        </div>

        <label>{t('general.notifyOnComplete')}</label>
        <input type="checkbox" style={{ justifySelf: 'start' }} checked={notifyOnComplete} onChange={e => onSetNotifyOnComplete(e.target.checked)} />
      </div>

      <IssueList issues={globalIssues} />

      <div className="group-title">{t('general.selectedFile')}</div>
      {!selected && <div className="hint">{t('general.selectFileHint')}</div>}
      {selected && <MediaInspector job={selected} />}
      {selected && <IssueList issues={selectedIssues} />}
    </>
  );
}

function MediaInspector({ job }: { job: Job }) {
  const { t } = useI18n();
  const m = job.media;
  if (job.status === 'analyzing') return <div className="hint">{t('media.reading')}</div>;
  if (job.status === 'failed' && !m) return <div className="issue error">{job.error}</div>;
  if (!m) return <div className="hint">{t('media.notAnalyzed')}</div>;
  return (
    <>
      <dl className="kv">
        <dt>{t('media.file')}</dt><dd className="mono" title={m.path}>{m.name}</dd>
        <dt>{t('media.size')}</dt><dd>{formatBytes(m.size)}</dd>
        <dt>{t('media.format')}</dt><dd>{m.formatLong ?? m.format ?? '—'}</dd>
        <dt>{t('media.duration')}</dt><dd>{formatDuration(m.duration)}</dd>
        <dt>{t('media.bitrate')}</dt><dd>{formatBitrate(m.bitRate)}</dd>
        {m.chapters > 0 && <><dt>{t('media.chapters')}</dt><dd>{m.chapters}</dd></>}
      </dl>
      {m.video && (
        <div className="stream-block">
          <h4>{t('media.video')}</h4>
          <dl className="kv">
            <dt>{t('media.codec')}</dt><dd>{m.video.codec_long_name ?? m.video.codec_name}{m.video.profile ? ` (${m.video.profile})` : ''}</dd>
            <dt>{t('media.size')}</dt><dd>{m.displayWidth}×{m.displayHeight}{m.isHdr ? ' · HDR' : ''} · {videoBitDepth(m.video)}-bit</dd>
            <dt>{t('media.frameRate')}</dt><dd>{formatFps(parseFrameRate(m.video.avg_frame_rate) ?? parseFrameRate(m.video.r_frame_rate))} fps</dd>
          </dl>
        </div>
      )}
      {m.audio.length > 0 && (
        <div className="stream-block">
          <h4>{t('media.audioHeading', { count: m.audio.length })}</h4>
          {m.audio.map(a => (
            <dl className="kv" key={a.index}>
              <dt>#{a.index}</dt><dd>{a.codec_name} · {a.channels ?? '?'}ch · {a.sample_rate ?? '?'}Hz{streamLanguage(a) ? ` · ${streamLanguage(a)}` : ''}</dd>
            </dl>
          ))}
        </div>
      )}
      {m.subtitles.length > 0 && (
        <div className="stream-block">
          <h4>{t('media.subtitlesHeading', { count: m.subtitles.length })}</h4>
          {m.subtitles.map(s => (
            <dl className="kv" key={s.index}>
              <dt>#{s.index}</dt><dd>{s.codec_name}{streamLanguage(s) ? ` · ${streamLanguage(s)}` : ''}{streamTitle(s) ? ` · ${streamTitle(s)}` : ''}</dd>
            </dl>
          ))}
        </div>
      )}
    </>
  );
}

// -----------------------------------------------------------------------------------------------
// Video tab
// -----------------------------------------------------------------------------------------------

function VideoTab({ settings, setSettings, encoders, media }: { settings: GlobalSettings; setSettings: React.Dispatch<React.SetStateAction<GlobalSettings>>; encoders: string[]; media?: MediaInfo }) {
  const { t } = useI18n();
  const codecs = selectableCodecs(settings.container, encoders.length ? encoders : CODEC_INFO[settings.codec].encoders);
  const encoder = resolveEncoder(settings.codec, encoders.length ? encoders : CODEC_INFO[settings.codec].encoders) ?? CODEC_INFO[settings.codec].encoders[0];
  const range = crfRange(encoder);
  const previewCrf = crfFor(encoder, settings.quality, settings.customCrf);

  return (
    <>
      <div className="group-title">{t('video.codecQuality')}</div>
      <div className="field-grid">
        <label>{t('video.videoCodec')}</label>
        <select value={settings.codec} onChange={e => setSettings(s => ({ ...s, codec: e.target.value as VideoCodec }))}>
          {(Object.keys(CODEC_INFO) as VideoCodec[]).map(c => {
            const allowed = CONTAINER_INFO[settings.container].videoCodecs.includes(c);
            const has = !encoders.length || resolveEncoder(c, encoders);
            return <option key={c} value={c} disabled={!allowed || !has}>{CODEC_INFO[c].label}{!allowed ? t('video.notSupported') : !has ? t('video.encoderNotFound') : ''}</option>;
          })}
        </select>
        <div className="hint">{t('video.encoderLine', { label: ENCODER_LABEL[encoder] })}{!codecs.includes(settings.codec) ? t('video.unavailableSettings') : ''}</div>

        <label>{t('video.quality')}</label>
        <select value={settings.quality} onChange={e => setSettings(s => ({ ...s, quality: e.target.value as QualityPreset }))}>
          {QUALITY_ORDER.map(q => <option key={q} value={q}>{qualityLabel(q, t)}</option>)}
        </select>
        {settings.quality === 'custom' ? (
          <>
            <label>{t('video.customCrf')}</label>
            <input className="text-input" type="number" min={range.min} max={range.max} value={settings.customCrf}
                   onChange={e => setSettings(s => ({ ...s, customCrf: Number(e.target.value) }))} />
          </>
        ) : (
          <div className="hint">{t('video.crfHint', { crf: previewCrf, encoder: ENCODER_LABEL[encoder] })}</div>
        )}

        <label>{t('video.speed')}</label>
        <select value={settings.speed} onChange={e => setSettings(s => ({ ...s, speed: e.target.value as SpeedPreset }))}>
          <option value="fast">{t('video.speedFast')}</option>
          <option value="balanced">{t('video.speedBalanced')}</option>
          <option value="slow">{t('video.speedSlow')}</option>
        </select>
      </div>

      <div className="group-title">{t('video.resFps')}</div>
      <div className="field-grid">
        <label>{t('video.shortEdge')}</label>
        <select value={String(settings.shortEdge)} onChange={e => setSettings(s => ({ ...s, shortEdge: e.target.value === 'source' ? 'source' : Number(e.target.value) }))}>
          <option value="source">{t('video.sameAsSource')}</option>
          {SHORT_EDGE_CHOICES.map(v => <option key={v} value={v}>{t('video.pOrSmaller', { v })}</option>)}
        </select>
        <div className="hint">{t('video.neverUpscale')}{media?.displayWidth ? t('video.sourceRes', { w: media.displayWidth, h: media.displayHeight ?? 0 }) : ''}</div>

        <label>{t('video.frameRate')}</label>
        <select value={String(settings.fps)} onChange={e => setSettings(s => ({ ...s, fps: e.target.value === 'source' ? 'source' : Number(e.target.value) }))}>
          <option value="source">{t('video.sameAsSource')}</option>
          {FPS_CHOICES.map(v => <option key={v} value={v}>{t('video.fpsValue', { v })}</option>)}
        </select>
      </div>

      <HardwareSection settings={settings} setSettings={setSettings} encoders={encoders} />
      <WatermarkSection settings={settings} setSettings={setSettings} />
    </>
  );
}

function HardwareSection({ settings, setSettings, encoders }: { settings: GlobalSettings; setSettings: React.Dispatch<React.SetStateAction<GlobalSettings>>; encoders: string[] }) {
  const { t } = useI18n();
  const available = availableHardware(settings.codec, encoders);
  const active = resolveHardware(settings.hwAccel, settings.codec, encoders);
  return (
    <>
      <div className="group-title">{t('video.hwGroup')}</div>
      <div className="field-grid">
        <label>{t('video.hwAccel')}</label>
        <select value={settings.hwAccel} onChange={e => setSettings(s => ({ ...s, hwAccel: e.target.value as HwAccelChoice }))}>
          <option value="off">{t('video.hwOff')}</option>
          <option value="auto">{t('video.hwAuto')}</option>
          {HW_BACKENDS.map(b => {
            const name = hardwareEncoderName(b, settings.codec);
            const has = !!name && (!encoders.length || available.includes(b));
            return <option key={b} value={b} disabled={!has}>{HW_LABEL[b]}{name ? ` — ${name}` : ''}{!has ? t('video.hwNotFound') : ''}</option>;
          })}
        </select>
        <div className="hint">
          {active ? t('video.hwUsing', { name: `${HW_LABEL[active]} (${hardwareEncoderName(active, settings.codec)})` }) : t('video.hwSoftware')} {t('video.hwHint')}
        </div>
      </div>
    </>
  );
}

const POSITION_KEY: Record<WatermarkPosition, TKey> = {
  'top-left': 'video.posTopLeft', 'top-center': 'video.posTopCenter', 'top-right': 'video.posTopRight',
  'center-left': 'video.posCenterLeft', center: 'video.posCenter', 'center-right': 'video.posCenterRight',
  'bottom-left': 'video.posBottomLeft', 'bottom-center': 'video.posBottomCenter', 'bottom-right': 'video.posBottomRight'
};

function WatermarkSection({ settings, setSettings }: { settings: GlobalSettings; setSettings: React.Dispatch<React.SetStateAction<GlobalSettings>> }) {
  const { t } = useI18n();
  const wm = settings.watermark;
  const update = (patch: Partial<WatermarkSettings>) => setSettings(s => ({ ...s, watermark: { ...s.watermark, ...patch } }));
  const choose = async () => {
    const file = await window.rozh.openImageDialog();
    if (file) update({ file, enabled: true });
  };
  return (
    <>
      <div className="group-title">{t('video.wmGroup')}</div>
      <div className="field-grid">
        <label>{t('video.wmEnable')}</label>
        <input type="checkbox" style={{ justifySelf: "start" }} checked={wm.enabled} onChange={e => update({ enabled: e.target.checked })} />

        <label>{t('video.wmFile')}</label>
        <div className="wm-file">
          <span className="wm-file-name" title={wm.file}>{wm.file ? basename(wm.file) : t('video.wmNone')}</span>
          <button type="button" className="btn small" onClick={() => void choose()}>{t('video.wmChoose')}</button>
          {wm.file && <button type="button" className="btn small" onClick={() => update({ file: undefined, enabled: false })}>{t('video.wmClear')}</button>}
        </div>

        {wm.enabled && (
          <>
            <label>{t('video.wmPosition')}</label>
            <div className="wm-grid" role="radiogroup" aria-label={t('video.wmPosition')}>
              {WATERMARK_POSITIONS.map(p => (
                <button key={p} type="button" role="radio" aria-checked={wm.position === p} title={t(POSITION_KEY[p])}
                        className={`wm-cell${wm.position === p ? ' active' : ''}`} onClick={() => update({ position: p })}>
                  <span className="wm-dot" />
                </button>
              ))}
            </div>
            <div className="hint">{t(POSITION_KEY[wm.position])}</div>

            <label>{t('video.wmSize')}</label>
            <div className="wm-range"><input type="range" min={2} max={50} value={wm.sizePct} onChange={e => update({ sizePct: Number(e.target.value) })} /><span>{wm.sizePct}%</span></div>

            <label>{t('video.wmMargin')}</label>
            <div className="wm-range"><input type="range" min={0} max={15} value={wm.marginPct} onChange={e => update({ marginPct: Number(e.target.value) })} /><span>{wm.marginPct}%</span></div>

            <label>{t('video.wmOpacity')}</label>
            <div className="wm-range"><input type="range" min={5} max={100} step={5} value={wm.opacityPct} onChange={e => update({ opacityPct: Number(e.target.value) })} /><span>{wm.opacityPct}%</span></div>

            <div className="hint">{t('video.wmHint')}</div>
          </>
        )}
      </div>
    </>
  );
}

function qualityLabel(q: QualityPreset, t: (key: TKey) => string): string {
  const map: Record<QualityPreset, TKey> = {
    source: 'video.qSource', lossless: 'video.qLossless', veryHigh: 'video.qVeryHigh',
    high: 'video.qHigh', balanced: 'video.qBalanced', small: 'video.qSmall', custom: 'video.qCustom'
  };
  return t(map[q]);
}

// -----------------------------------------------------------------------------------------------
// Audio tab
// -----------------------------------------------------------------------------------------------

function AudioTab({ settings, setSettings, media }: { settings: GlobalSettings; setSettings: React.Dispatch<React.SetStateAction<GlobalSettings>>; media?: MediaInfo }) {
  const { t } = useI18n();
  const allowed = CONTAINER_INFO[settings.container].audioEncode;
  return (
    <>
      <div className="group-title">{t('audio.audio')}</div>
      <div className="field-grid">
        <label>{t('audio.audio')}</label>
        <select value={settings.audioMode} onChange={e => {
          const mode = e.target.value as GlobalSettings['audioMode'];
          setSettings(s => ({ ...s, audioMode: mode, audioBitrateKbps: mode === 'copy' ? s.audioBitrateKbps : DEFAULT_AUDIO_KBPS[mode as 'aac' | 'opus'] }));
        }}>
          <option value="copy">{t('audio.copy')}</option>
          {allowed.includes('aac') && <option value="aac">{t('audio.toAac')}</option>}
          {allowed.includes('opus') && <option value="opus">{t('audio.toOpus')}</option>}
        </select>
        {settings.audioMode !== 'copy' && (
          <>
            <label>{t('audio.bitratePerTrack')}</label>
            <select value={settings.audioBitrateKbps} onChange={e => setSettings(s => ({ ...s, audioBitrateKbps: Number(e.target.value) }))}>
              {AUDIO_BITRATE_CHOICES.map(v => <option key={v} value={v}>{t('audio.kbps', { v })}</option>)}
            </select>
            <div className="hint">{t('audio.multichannelHint')}</div>
          </>
        )}
      </div>
      {media && media.audio.length > 0 && (
        <div className="stream-block">
          <h4>{t('audio.sourceTracks')}</h4>
          <table className="tracks">
            <thead><tr><th>#</th><th>{t('audio.colCodec')}</th><th>{t('audio.colChannels')}</th><th>{t('audio.colLanguage')}</th></tr></thead>
            <tbody>{media.audio.map(a => <tr key={a.index}><td>{a.index}</td><td>{a.codec_name}</td><td>{a.channels ?? '—'}</td><td>{streamLanguage(a) || '—'}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

// -----------------------------------------------------------------------------------------------
// Subtitles tab
// -----------------------------------------------------------------------------------------------

type SubtitlePatch = { externalSubtitle?: string | null; keepSubtitles?: number[] | null; burnStream?: number | null };
type QueueAction = { type: 'setSubtitle'; id: string; patch: SubtitlePatch };

function SubtitlesTab({ settings, setSettings, selected, dispatch, previewSettingsFor }: {
  settings: GlobalSettings; setSettings: React.Dispatch<React.SetStateAction<GlobalSettings>>; selected?: Job; dispatch: React.Dispatch<QueueAction>;
  previewSettingsFor: (job: Job) => EncodeSettings;
}) {
  const { t } = useI18n();
  const media = selected?.media;
  const editable = !!selected && isEditable(selected);
  const keepList = selected ? (selected.keepSubtitles ?? defaultKeepSubtitles(media, settings.container)) : [];
  const burnStream = selected ? (selected.burnStream ?? defaultBurnStream(media)) : undefined;

  const pickExternal = async () => {
    if (!selected) return;
    const file = await window.rozh.openSubtitleDialog();
    if (file) dispatch({ type: 'setSubtitle', id: selected.id, patch: { externalSubtitle: file } });
  };
  const clearExternal = () => { if (selected) dispatch({ type: 'setSubtitle', id: selected.id, patch: { externalSubtitle: null } }); };
  const toggleKeep = (index: number) => {
    if (!selected) return;
    const next = keepList.includes(index) ? keepList.filter(i => i !== index) : [...keepList, index];
    dispatch({ type: 'setSubtitle', id: selected.id, patch: { keepSubtitles: next } });
  };

  return (
    <>
      <div className="group-title">{t('subtitles.subtitles')}</div>
      <div className="field-grid">
        <label>{t('subtitles.mode')}</label>
        <select value={settings.subtitleMode} onChange={e => setSettings(s => ({ ...s, subtitleMode: e.target.value as GlobalSettings['subtitleMode'] }))}>
          <option value="keep">{t('subtitles.modeKeep')}</option>
          <option value="none">{t('subtitles.modeNone')}</option>
          <option value="burn">{t('subtitles.modeBurn')}</option>
        </select>
        {settings.subtitleMode === 'burn' && <div className="hint">{t('subtitles.burnHint')}</div>}

        <label>{t('subtitles.externalFile')}</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <div className="text-input" style={{ flex: 1, color: selected?.externalSubtitle ? 'inherit' : 'var(--text-faint)' }}>
            {selected?.externalSubtitle ? basename(selected.externalSubtitle) : t('subtitles.noneChosen')}
          </div>
          <button className="btn small" disabled={!editable} onClick={pickExternal}>{t('subtitles.choose')}</button>
          {selected?.externalSubtitle && <button className="btn small" disabled={!editable} onClick={clearExternal}>{t('subtitles.clear')}</button>}
        </div>

        <label>{t('subtitles.textEncoding')}</label>
        <select value={settings.subtitleEncoding} onChange={e => setSettings(s => ({ ...s, subtitleEncoding: e.target.value as GlobalSettings['subtitleEncoding'] }))}>
          {Object.entries(SUBTITLE_ENCODINGS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <div className="hint">{t('subtitles.encodingHint')}</div>
      </div>


      {settings.subtitleMode === 'burn' && selected && media && (
        <SubtitlePreview job={selected} previewSettingsFor={previewSettingsFor} />
      )}

      {!selected && <div className="hint" style={{ marginTop: 10 }}>{t('subtitles.selectFileHint')}</div>}

      {selected && media && media.subtitles.length > 0 && settings.subtitleMode === 'keep' && (
        <div className="stream-block">
          <h4>{t('subtitles.embeddedKeep')}</h4>
          <table className="tracks">
            <thead><tr><th></th><th>#</th><th>{t('subtitles.colCodec')}</th><th>{t('subtitles.colLanguage')}</th></tr></thead>
            <tbody>
              {media.subtitles.map(s => {
                const fit = subtitleFitsContainer(settings.container, s.codec_name);
                return (
                  <tr key={s.index} className={fit.ok ? '' : 'unfit'}>
                    <td><input type="checkbox" disabled={!editable || !fit.ok} checked={fit.ok && keepList.includes(s.index)} onChange={() => toggleKeep(s.index)} /></td>
                    <td>{s.index}</td><td>{s.codec_name}</td><td>{streamLanguage(s) || '—'}{!fit.ok ? ` — ${fit.reason}` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && media && settings.subtitleMode === 'burn' && !selected.externalSubtitle && (
        <div className="stream-block">
          <h4>{t('subtitles.embeddedBurn')}</h4>
          {media.subtitles.filter(s => isBurnableEmbedded(s.codec_name)).length === 0
            ? <div className="hint">{t('subtitles.noBurnable')}</div>
            : (
              <table className="tracks">
                <thead><tr><th></th><th>#</th><th>{t('subtitles.colCodec')}</th><th>{t('subtitles.colLanguage')}</th></tr></thead>
                <tbody>
                  {media.subtitles.filter(s => isBurnableEmbedded(s.codec_name)).map(s => (
                    <tr key={s.index}>
                      <td><input type="radio" name="burn" disabled={!editable} checked={burnStream === s.index} onChange={() => dispatch({ type: 'setSubtitle', id: selected.id, patch: { burnStream: s.index } })} /></td>
                      <td>{s.index}</td><td>{s.codec_name}</td><td>{streamLanguage(s) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      )}
    </>
  );
}

// -----------------------------------------------------------------------------------------------
// Subtitle preview (one frame with the subtitle burned in)
// -----------------------------------------------------------------------------------------------

type PreviewState =
  | { phase: 'idle' }
  | { phase: 'busy' }
  | { phase: 'done'; result: Extract<SubtitlePreviewResult, { status: 'ok' }> }
  | { phase: 'error'; message: string };

function SubtitlePreview({ job, previewSettingsFor }: { job: Job; previewSettingsFor: (job: Job) => EncodeSettings }) {
  const { t } = useI18n();
  const [state, setState] = useState<PreviewState>({ phase: 'idle' });
  const [atSec, setAtSec] = useState<number | undefined>(undefined);
  // Only the most recent request may update the screen: a slow earlier one must not overwrite a newer picture.
  const requestId = useRef(0);

  // A picture of another file (or of different settings) would be misleading, so start fresh per file.
  useEffect(() => { requestId.current++; setState({ phase: 'idle' }); setAtSec(undefined); }, [job.id]);

  const run = async () => {
    const id = ++requestId.current;
    setState({ phase: 'busy' });
    try {
      const result = await window.rozh.previewSubtitle(previewSettingsFor(job), atSec);
      if (id !== requestId.current) return;
      setState(result.status === 'ok' ? { phase: 'done', result } : { phase: 'error', message: result.error });
    } catch (error) {
      if (id !== requestId.current) return;
      setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const busy = state.phase === 'busy';
  return (
    <div className="stream-block subtitle-preview">
      <h4>{t('subtitles.previewHeading')}</h4>
      <div className="field-grid">
        <label>{t('subtitles.previewAt')}</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <TimecodeField value={atSec} onCommit={s => setAtSec(s ?? undefined)} disabled={busy} placeholder={t('subtitles.previewAtAuto')} />
          <button className="btn small primary" disabled={busy} onClick={() => void run()}>
            {busy ? t('subtitles.previewBusy') : t('subtitles.previewButton')}
          </button>
        </div>
        <div className="hint">{t('subtitles.previewHint')}</div>
      </div>

      {state.phase === 'error' && <div className="preview-error" role="alert">{t('subtitles.previewFailed', { error: state.message })}</div>}
      {state.phase === 'done' && (
        <figure className="preview-figure">
          <img src={`data:image/png;base64,${state.result.png}`} alt={t('subtitles.previewAlt')} />
          <figcaption>
            {t('subtitles.previewCaption', { time: formatTimecode(state.result.timeSec), size: state.result.width && state.result.height ? `${state.result.width}×${state.result.height}` : '—' })}
            {state.result.how === 'fallback' && <div className="hint" style={{ gridColumn: 'auto', marginTop: 4 }}>{t('subtitles.previewNoText')}</div>}
          </figcaption>
        </figure>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// Trim tab
// -----------------------------------------------------------------------------------------------

type TrimPatch = { startSec?: number | null; endSec?: number | null };
type TrimAction = { type: 'setTrim'; id: string; patch: TrimPatch };

/** Local text-field state for a timecode input: keeps whatever the user is typing, even mid-edit invalid text. */
function TimecodeField({ value, onCommit, disabled, placeholder }: {
  value?: number; onCommit: (seconds: number | null) => void; disabled?: boolean; placeholder: string;
}) {
  const [text, setText] = useState(() => formatTimecode(value));
  const [invalid, setInvalid] = useState(false);
  // Follow external changes (job switch, clear button) while the field isn't mid-edit-focus.
  useEffect(() => { setText(formatTimecode(value)); setInvalid(false); }, [value]);

  const commit = () => {
    const parsed = parseTimecode(text);
    if (parsed === undefined) { setInvalid(false); onCommit(null); return; }
    if (Number.isNaN(parsed)) { setInvalid(true); return; }
    setInvalid(false);
    onCommit(parsed);
  };

  return (
    <input
      className={`text-input${invalid ? ' invalid' : ''}`}
      style={{ width: 120 }}
      type="text"
      inputMode="numeric"
      placeholder={placeholder}
      value={text}
      disabled={disabled}
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

function TrimTab({ selected, dispatch }: { selected?: Job; dispatch: React.Dispatch<TrimAction> }) {
  const { t } = useI18n();
  const editable = !!selected && isEditable(selected);
  const duration = selected?.media?.duration;

  const setStart = (startSec: number | null) => { if (selected) dispatch({ type: 'setTrim', id: selected.id, patch: { startSec } }); };
  const setEnd = (endSec: number | null) => { if (selected) dispatch({ type: 'setTrim', id: selected.id, patch: { endSec } }); };
  const clear = () => { if (selected) dispatch({ type: 'setTrim', id: selected.id, patch: { startSec: null, endSec: null } }); };

  const hasTrim = selected?.trimStartSec !== undefined || selected?.trimEndSec !== undefined;
  const trimmedLength = duration !== undefined
    ? Math.max(0, (selected?.trimEndSec ?? duration) - (selected?.trimStartSec ?? 0))
    : undefined;

  return (
    <>
      <div className="group-title">{t('trim.trim')}</div>
      {!selected && <div className="hint">{t('trim.selectFileHint')}</div>}
      {selected && (
        <div className="field-grid">
          <label>{t('trim.start')}</label>
          <TimecodeField value={selected.trimStartSec} onCommit={setStart} disabled={!editable} placeholder="00:00:00" />

          <label>{t('trim.end')}</label>
          <TimecodeField value={selected.trimEndSec} onCommit={setEnd} disabled={!editable} placeholder={formatTimecode(duration) || '00:00:00'} />

          <label />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {hasTrim && <button className="btn small" disabled={!editable} onClick={clear}>{t('trim.clear')}</button>}
            {hasTrim && trimmedLength !== undefined && <span className="hint">{t('trim.resultLength', { length: formatDuration(trimmedLength) })}</span>}
          </div>
        </div>
      )}
      <div className="hint" style={{ marginTop: 10 }}>{t('trim.hint')}</div>
    </>
  );
}

// -----------------------------------------------------------------------------------------------
// Advanced tab
// -----------------------------------------------------------------------------------------------

function AdvancedTab({ selected, status }: { selected?: Job; status?: FfmpegStatus }) {
  const { t } = useI18n();
  return (
    <>
      <div className="group-title">{t('advanced.ffmpegGroup')}</div>
      <dl className="kv">
        <dt>{t('advanced.ffmpegPath')}</dt><dd className="mono">{status?.ffmpeg.path ?? '—'}</dd>
        <dt>{t('advanced.ffprobePath')}</dt><dd className="mono">{status?.ffprobe.path ?? '—'}</dd>
        <dt>{t('advanced.encoders')}</dt><dd>{t('advanced.encodersFound', { count: status?.encoders.length ?? 0 })}</dd>
        {status?.hardware && status.hardware.length > 0 && <><dt>{t('advanced.hardware')}</dt><dd>{t('advanced.hardwareNotUsed', { list: status.hardware.join(', ') })}</dd></>}
      </dl>
      <div className="group-title">{t('advanced.thisFile')}</div>
      {selected ? (
        <dl className="kv">
          <dt>{t('advanced.input')}</dt><dd className="mono">{selected.input}</dd>
          <dt>{t('advanced.output')}</dt><dd className="mono">{selected.output ?? '—'}</dd>
          <dt>{t('advanced.overwrite')}</dt><dd>{selected.overwrite ? t('advanced.overwriteYes') : t('advanced.overwriteNo')}</dd>
        </dl>
      ) : <div className="hint">{t('advanced.selectFileHint')}</div>}
    </>
  );
}

// -----------------------------------------------------------------------------------------------
// Log tab
// -----------------------------------------------------------------------------------------------

function LogTab({ selected, openLog, onView }: { selected?: Job; openLog?: { path: string; text?: string; error?: string }; onView: () => void }) {
  const { t } = useI18n();
  if (!selected) return <div className="hint">{t('log.selectFileHint')}</div>;
  if (selected.status === 'failed' && selected.error) {
    return (
      <>
        <div className="issue error">{selected.error}</div>
        {selected.detail && <pre className="log-box">{selected.detail}</pre>}
        {selected.logPath && <button className="btn small" style={{ marginTop: 8 }} onClick={onView}>{t('log.viewFull')}</button>}
        {openLog && openLog.path === selected.logPath && openLog.text && <pre className="log-box" style={{ marginTop: 8 }}>{openLog.text}</pre>}
        {openLog && openLog.path === selected.logPath && openLog.error && <div className="issue error" style={{ marginTop: 8 }}>{openLog.error}</div>}
      </>
    );
  }
  if (!selected.logPath) return <div className="hint">{t('log.noLog')}</div>;
  return (
    <>
      <button className="btn small" onClick={onView}>{t('log.viewFull')}</button>
      {openLog && openLog.path === selected.logPath && openLog.text && <pre className="log-box" style={{ marginTop: 8 }}>{openLog.text}</pre>}
      {openLog && openLog.path === selected.logPath && openLog.error && <div className="issue error" style={{ marginTop: 8 }}>{openLog.error}</div>}
    </>
  );
}

// -----------------------------------------------------------------------------------------------
// Encoder Logs tab: every log file Rozh has written, app-wide (not tied to the selected job)
// -----------------------------------------------------------------------------------------------

function EncoderLogsTab({ state, onRefresh, onView, onOpenFolder, onClearAll }: {
  state: EncoderLogsState;
  onRefresh: () => void;
  onView: (path: string) => void;
  onOpenFolder: () => void;
  onClearAll: () => void;
}) {
  const { t } = useI18n();
  const { files, loading, error, selected, text, textError } = state;

  const clear = () => {
    if (window.confirm(t('encoderLogs.confirmClear'))) onClearAll();
  };

  return (
    <>
      <div className="group-title">{t('encoderLogs.title')}</div>
      <div className="hint" style={{ marginBottom: 8 }}>{t('encoderLogs.intro')}</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button className="btn small" onClick={onRefresh} disabled={loading}>{loading ? t('encoderLogs.loading') : t('encoderLogs.refresh')}</button>
        <button className="btn small" onClick={onOpenFolder}>{t('encoderLogs.openFolder')}</button>
        <button className="btn small danger" onClick={clear} disabled={!files.length}>{t('encoderLogs.clearAll')}</button>
      </div>

      {error && <div className="issue error">{error}</div>}
      {!error && !loading && !files.length && <div className="hint">{t('encoderLogs.empty')}</div>}

      {!!files.length && (
        <table className="tracks">
          <thead>
            <tr><th>{t('encoderLogs.colName')}</th><th style={{ width: 90 }}>{t('encoderLogs.colSize')}</th><th style={{ width: 160 }}>{t('encoderLogs.colDate')}</th></tr>
          </thead>
          <tbody>
            {files.map(f => (
              <tr key={f.path} className={f.path === selected ? 'selected' : ''} style={{ cursor: 'pointer' }} onClick={() => onView(f.path)}>
                <td className="mono">{f.name}</td>
                <td>{formatBytes(f.size)}</td>
                <td>{new Date(f.mtimeMs).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!selected && !!files.length && <div className="hint" style={{ marginTop: 8 }}>{t('encoderLogs.selectHint')}</div>}
      {selected && text !== undefined && <pre className="log-box" style={{ marginTop: 8 }}>{text}</pre>}
      {selected && textError && <div className="issue error" style={{ marginTop: 8 }}>{textError}</div>}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <LanguageProvider>
    <App />
  </LanguageProvider>
);
