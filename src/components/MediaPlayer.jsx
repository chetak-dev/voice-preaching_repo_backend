import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { fileUrl } from '../api.js';

const PlayerContext = createContext(null);
const PROGRESS_KEY = 'voice-player-progress-v1';
const LAST_KEY = 'voice-player-last-id-v1';
const SPEED_KEY = 'voice-player-speed-v1';
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

function safeGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* storage may be unavailable */ }
}
function safeRemove(key) {
  try { window.localStorage.removeItem(key); } catch { /* storage may be unavailable */ }
}
function readProgress() {
  try {
    const value = JSON.parse(safeGet(PROGRESS_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function MediaPlayerProvider({ children }) {
  const [currentItem, setCurrentItem] = useState(null);
  const [startAt, setStartAt] = useState(0);
  const [shouldAutoplay, setShouldAutoplay] = useState(false);
  const [lastContentId, setLastContentId] = useState(() => safeGet(LAST_KEY));
  const [progressById, setProgressById] = useState(readProgress);
  const [playbackRate, setPlaybackRateState] = useState(() => {
    const saved = Number(safeGet(SPEED_KEY));
    return SPEEDS.includes(saved) ? saved : 1;
  });
  const saveStamp = useRef({});

  const openPlayer = useCallback(item => {
    const saved = readProgress()[item.id];
    const resumeAt = saved && saved.duration > 0 && saved.currentTime < saved.duration - 2 ? saved.currentTime : 0;
    setCurrentItem(item); setStartAt(resumeAt); setShouldAutoplay(true); setLastContentId(item.id);
    safeSet(LAST_KEY, item.id);
  }, []);
  const saveProgress = useCallback((id, currentTime, duration, force = false) => {
    if (!id || !Number.isFinite(currentTime) || currentTime < 0) return;
    const progress = { currentTime, duration: Number.isFinite(duration) ? duration : 0, updatedAt: Date.now() };
    setProgressById(current => {
      const next = { ...current, [id]: progress };
      const now = Date.now();
      if (force || now - (saveStamp.current[id] || 0) >= 5000) {
        saveStamp.current[id] = now;
        safeSet(PROGRESS_KEY, JSON.stringify(next));
      }
      return next;
    });
  }, []);
  const closePlayer = useCallback(() => { setShouldAutoplay(false); setCurrentItem(null); }, []);
  const setPlaybackRate = useCallback(rate => {
    const next = Number(rate);
    if (!SPEEDS.includes(next)) return;
    setPlaybackRateState(next); safeSet(SPEED_KEY, String(next));
  }, []);
  const finish = useCallback(id => {
    setProgressById(current => {
      const next = { ...current }; delete next[id]; safeSet(PROGRESS_KEY, JSON.stringify(next)); return next;
    });
    setLastContentId(current => { if (current !== id) return current; safeRemove(LAST_KEY); return null; });
  }, []);

  const value = { currentItem, startAt, shouldAutoplay, lastContentId, progressById, playbackRate, openPlayer, saveProgress, closePlayer, setPlaybackRate, finish };
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function useMediaPlayer() {
  const value = useContext(PlayerContext);
  if (!value) throw new Error('useMediaPlayer must be used inside MediaPlayerProvider.');
  return value;
}

export function PersistentMediaPlayer() {
  const { currentItem, startAt, shouldAutoplay, progressById, playbackRate, closePlayer, saveProgress, setPlaybackRate, finish } = useMediaPlayer();
  const mediaRef = useRef(null);
  const [mediaError, setMediaError] = useState('');
  useEffect(() => { setMediaError(''); if (mediaRef.current) mediaRef.current.playbackRate = playbackRate; }, [currentItem?.id, playbackRate]);
  if (!currentItem) return null;
  const progress = progressById[currentItem.id];
  function onLoadedMetadata(event) {
    const media = event.currentTarget;
    media.playbackRate = playbackRate;
    if (startAt > 0 && Number.isFinite(media.duration) && media.duration > startAt + 1) media.currentTime = startAt;
    if (Number.isFinite(media.duration) && media.duration > 0) saveProgress(currentItem.id, media.currentTime, media.duration, true);
    if (shouldAutoplay && !mediaError) media.play().catch(() => {});
  }
  function onTimeUpdate(event) { saveProgress(currentItem.id, event.currentTarget.currentTime, event.currentTarget.duration); }
  function onPause(event) { if (!event.currentTarget.ended) saveProgress(currentItem.id, event.currentTarget.currentTime, event.currentTarget.duration, true); }
  const mediaProps = {
    key: currentItem.id, ref: mediaRef, src: fileUrl(currentItem.id, true), controls: true, preload: 'metadata',
    onLoadedMetadata, onTimeUpdate, onPause, onEnded: () => finish(currentItem.id),
    onError: () => setMediaError('Unable to load this media. It may no longer be available.'),
  };
  return (
    <section className="fixed bottom-[4.5rem] left-3 right-3 z-40 mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-2xl backdrop-blur sm:bottom-4 sm:left-auto sm:right-5 sm:w-[min(42rem,calc(100vw-2rem))]" aria-label="Persistent media player">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-900">{currentItem.title}</p>
          <p className="text-xs text-slate-500">{currentItem.type === 'video' ? 'Video player' : 'Audio player'}{progress?.currentTime ? ` · ${formatTime(progress.currentTime)} listened` : ''}</p></div>
        <div className="flex shrink-0 items-center gap-2"><label className="flex items-center gap-1 text-xs text-slate-500">Speed
          <select className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-700" value={playbackRate} onChange={event => setPlaybackRate(event.target.value)} aria-label="Playback speed">
            {SPEEDS.map(speed => <option key={speed} value={speed}>{speed}×</option>)}
          </select></label>
          <button type="button" className="rounded-lg px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900" onClick={closePlayer} aria-label="Close player">Close</button>
        </div>
      </div>
      {mediaError && <p className="mb-2 text-xs text-rose-600">{mediaError}</p>}
      {currentItem.type === 'video' ? <video {...mediaProps} playsInline className="max-h-56 w-full rounded-lg bg-black" />
        : <audio {...mediaProps} className="w-full" />}
      <span className="sr-only">Resume position: {formatTime(progress?.currentTime || 0)}</span>
    </section>
  );
}
