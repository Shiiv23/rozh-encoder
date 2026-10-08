import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import en from './en';
import ckb from './ckb';
import type { Dict } from './en';

export type Lang = 'en' | 'ckb';
export const LANGS: Lang[] = ['en', 'ckb'];
export const RTL_LANGS: Lang[] = ['ckb'];

const DICTS: Record<Lang, Dict> = { en, ckb };
const STORAGE_KEY = 'rozh:lang';

// Flatten nested dict into dot-path keys, e.g. "ribbon.addFiles".
type Path<T, Prefix extends string = ''> = T extends string
  ? Prefix
  : { [K in keyof T & string]: Path<T[K], `${Prefix}${Prefix extends '' ? '' : '.'}${K}`> }[keyof T & string];
export type TKey = Path<Dict>;

function lookup(dict: Dict, path: string): string | undefined {
  const parts = path.split('.');
  let node: unknown = dict;
  for (const part of parts) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

export function dirFor(lang: Lang): 'ltr' | 'rtl' {
  return RTL_LANGS.includes(lang) ? 'rtl' : 'ltr';
}

function detectInitialLang(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'ckb') return stored;
  } catch { /* localStorage unavailable — fall through */ }
  // Fall back to the OS/browser locale if it's Kurdish; otherwise default to English.
  const nav = typeof navigator !== 'undefined' ? navigator.language ?? '' : '';
  if (nav.toLowerCase().startsWith('ku')) return 'ckb';
  return 'en';
}

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  dir: 'ltr' | 'rtl';
  t: (key: TKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => detectInitialLang());
  const dir = dirFor(lang);

  useEffect(() => {
    document.documentElement.lang = lang === 'ckb' ? 'ckb' : 'en';
    document.documentElement.dir = dir;
  }, [lang, dir]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  }, []);

  const t = useCallback((key: TKey, vars?: Record<string, string | number>): string => {
    const dict = DICTS[lang];
    // Plural resolution: if a `count` var is given, prefer `<key>_one` / `<key>_other`,
    // falling back to the base key untouched (Kurdish keys are identical either way).
    if (vars && typeof vars.count === 'number') {
      const suffixed = `${key}_${vars.count === 1 ? 'one' : 'other'}`;
      const plural = lookup(dict, suffixed);
      if (plural !== undefined) return interpolate(plural, vars);
    }
    const value = lookup(dict, key) ?? lookup(en, key) ?? key;
    return interpolate(value, vars);
  }, [lang]);

  const value = useMemo<I18nContextValue>(() => ({ lang, setLang, dir, t }), [lang, setLang, dir, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within a LanguageProvider');
  return ctx;
}

export function LanguageSwitcher() {
  const { lang, setLang, t } = useI18n();
  return (
    <div className="lang-switch" role="group" aria-label={t('language.label')}>
      {LANGS.map(l => (
        <button
          key={l}
          type="button"
          className={`lang-btn${lang === l ? ' active' : ''}`}
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
        >
          {l === 'en' ? t('language.english') : t('language.kurdish')}
        </button>
      ))}
    </div>
  );
}
