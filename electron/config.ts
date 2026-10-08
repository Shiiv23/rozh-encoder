import fs from 'node:fs/promises';
import path from 'node:path';
import type { LogFileInfo } from './types';

export interface StoredConfig { ffmpeg?: string; ffprobe?: string }

export async function loadConfig(dir: string): Promise<StoredConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as StoredConfig;
    return { ffmpeg: typeof raw.ffmpeg === 'string' ? raw.ffmpeg : undefined, ffprobe: typeof raw.ffprobe === 'string' ? raw.ffprobe : undefined };
  } catch {
    return {};
  }
}

export async function saveConfig(dir: string, config: StoredConfig): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

/** Writes a log file and keeps only the newest `keep` logs. */
export async function writeLogFile(logDir: string, jobId: string, text: string, keep = 50): Promise<string> {
  await fs.mkdir(logDir, { recursive: true });
  const safeId = jobId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'job';
  const file = path.join(logDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeId}.log`);
  await fs.writeFile(file, text, 'utf8');
  try {
    const logs = (await fs.readdir(logDir)).filter(n => n.endsWith('.log')).sort();
    for (const old of logs.slice(0, Math.max(0, logs.length - keep))) await fs.rm(path.join(logDir, old), { force: true });
  } catch { /* pruning is best effort */ }
  return file;
}

/** True when `file` is inside `dir` (used so the renderer can only read Rozh's own logs). */
export function isInside(dir: string, file: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Every `.log` file Rozh has written, newest first. Missing directory reads as an empty list. */
export async function listLogFiles(logDir: string): Promise<LogFileInfo[]> {
  let names: string[];
  try {
    names = (await fs.readdir(logDir)).filter(n => n.endsWith('.log'));
  } catch {
    return [];
  }
  const files = await Promise.all(names.map(async name => {
    const filePath = path.join(logDir, name);
    try {
      const stat = await fs.stat(filePath);
      return { name, path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return undefined;
    }
  }));
  return files.filter((f): f is LogFileInfo => !!f).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Deletes every log file in `logDir`. Best effort: a file that can't be removed is just skipped. */
export async function clearLogFiles(logDir: string): Promise<void> {
  let names: string[];
  try {
    names = (await fs.readdir(logDir)).filter(n => n.endsWith('.log'));
  } catch {
    return;
  }
  await Promise.all(names.map(name => fs.rm(path.join(logDir, name), { force: true }).catch(() => undefined)));
}
