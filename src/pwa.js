import { useSyncExternalStore } from 'react';

// Chrome/Edge/Android fire beforeinstallprompt; iOS Safari only supports "Add to Home Screen" from the Share menu.
let deferred = null;
let installed = typeof window !== 'undefined'
  && (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true);
const listeners = new Set();
const emit = () => listeners.forEach(listener => listener());

export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function setupPwa() {
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferred = event; emit(); });
  window.addEventListener('appinstalled', () => { deferred = null; installed = true; emit(); });
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
}

const snapshot = () => (installed ? 'installed' : deferred ? 'prompt' : isIos() ? 'ios' : 'none');
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export const useInstallState = () => useSyncExternalStore(subscribe, snapshot);

export async function promptInstall() {
  if (!deferred) return false;
  const event = deferred;
  deferred = null;
  emit();
  await event.prompt();
  const { outcome } = await event.userChoice;
  return outcome === 'accepted';
}
