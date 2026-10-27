import React from 'react';

export const THEME_KEY = 'kt.theme';
export const THEME_EVENT = 'kt-theme';
export const THEMES = ['light', 'dark', 'system'];

const THEME_COLORS = { light: '#4f46e5', dark: '#0f172a' };
const QUERY = '(prefers-color-scheme: dark)';

const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(QUERY) : null);

export function getTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return THEMES.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(pref = getTheme()) {
  if (pref === 'light' || pref === 'dark') return pref;
  return media()?.matches ? 'dark' : 'light';
}

export function applyTheme(pref = getTheme()) {
  if (typeof document === 'undefined') return;
  const resolved = resolveTheme(pref);
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', THEME_COLORS[resolved]);
}

export function setTheme(pref) {
  const next = THEMES.includes(pref) ? pref : 'system';
  try {
    if (next === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch { /* storage unavailable */ }
  applyTheme(next);
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: next }));
}

export function useTheme() {
  const [pref, setPref] = React.useState(getTheme);

  React.useEffect(() => {
    const onChange = event => setPref(THEMES.includes(event.detail) ? event.detail : getTheme());
    const onStorage = event => {
      if (event.key !== THEME_KEY && event.key !== null) return;
      const next = getTheme();
      applyTheme(next);
      setPref(next);
    };
    window.addEventListener(THEME_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(THEME_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  React.useEffect(() => {
    if (pref !== 'system') return undefined;
    const mql = media();
    if (!mql) return undefined;
    const onSystemChange = () => applyTheme('system');
    if (mql.addEventListener) mql.addEventListener('change', onSystemChange);
    else mql.addListener(onSystemChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onSystemChange);
      else mql.removeListener(onSystemChange);
    };
  }, [pref]);

  return [pref, setTheme];
}
