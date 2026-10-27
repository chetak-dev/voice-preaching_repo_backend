import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Music, Pause, Play, RotateCcw, RotateCw, Video, X } from 'lucide-react';
import { fileUrl, thumbnailUrl } from '../api.js';
import { cx } from './ui.jsx';

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

const SKIP_SECONDS = 15;

export function PersistentMediaPlayer() {
  const { currentItem, startAt, shouldAutoplay, progressById, playbackRate, closePlayer, saveProgress, setPlaybackRate, finish } = useMediaPlayer();
  const mediaRef = useRef(null);
  const [mediaError, setMediaError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [minimized, setMinimized] = useState(false);
  useEffect(() => { setMediaError(''); if (mediaRef.current) mediaRef.current.playbackRate = playbackRate; }, [currentItem?.id, playbackRate]);
  useEffect(() => { setMinimized(false); setPlaying(false); }, [currentItem?.id]);

  const skip = useCallback(seconds => {
    const media = mediaRef.current;
    if (!media || !Number.isFinite(media.duration)) return;
    media.currentTime = Math.min(Math.max(0, media.currentTime + seconds), media.duration);
  }, []);
  const toggle = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) media.play().catch(() => {}); else media.pause();
  }, []);

  // Lock-screen / notification controls on phones, and media keys on desktops.
  useEffect(() => {
    const session = typeof navigator !== 'undefined' ? navigator.mediaSession : null;
    if (!session || !currentItem) return undefined;
    try {
      session.metadata = new window.MediaMetadata({
        title: currentItem.title,
        artist: currentItem.uploader || 'Kalpa Taru',
        album: 'Kalpa Taru',
        artwork: currentItem.has_thumb
          ? [{ src: thumbnailUrl(currentItem.id), sizes: '512x512', type: 'image/jpeg' }]
          : [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
    } catch { /* MediaMetadata unsupported */ }
    const handlers = {
      play: () => mediaRef.current?.play().catch(() => {}),
      pause: () => mediaRef.current?.pause(),
      seekbackward: details => skip(-(details?.seekOffset || SKIP_SECONDS)),
      seekforward: details => skip(details?.seekOffset || SKIP_SECONDS),
      seekto: details => { if (mediaRef.current && Number.isFinite(details?.seekTime)) mediaRef.current.currentTime = details.seekTime; },
      stop: () => closePlayer(),
    };
    Object.entries(handlers).forEach(([action, handler]) => { try { session.setActionHandler(action, handler); } catch { /* unsupported action */ } });
    return () => {
      Object.keys(handlers).forEach(action => { try { session.setActionHandler(action, null); } catch { /* unsupported action */ } });
      session.metadata = null;
    };
  }, [currentItem, skip, closePlayer]);
  useEffect(() => {
    if (navigator.mediaSession && currentItem) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }, [playing, currentItem]);

  if (!currentItem) return null;
  const progress = progressById[currentItem.id];
  const percent = progress?.duration > 0 ? Math.min(100, (progress.currentTime / progress.duration) * 100) : 0;
  function onLoadedMetadata(event) {
    const media = event.currentTarget;
    media.playbackRate = playbackRate;
    if (startAt > 0 && Number.isFinite(media.duration) && media.duration > startAt + 1) media.currentTime = startAt;
    if (Number.isFinite(media.duration) && media.duration > 0) saveProgress(currentItem.id, media.currentTime, media.duration, true);
    if (shouldAutoplay && !mediaError) media.play().catch(() => {});
  }
  function onTimeUpdate(event) { saveProgress(currentItem.id, event.currentTarget.currentTime, event.currentTarget.duration); }
  function onPause(event) {
    setPlaying(false);
    if (!event.currentTarget.ended) saveProgress(currentItem.id, event.currentTarget.currentTime, event.currentTarget.duration, true);
  }
  const mediaProps = {
    ref: mediaRef, src: fileUrl(currentItem.id, true), controls: currentItem.type === 'video', preload: 'metadata',
    onLoadedMetadata, onTimeUpdate, onPause, onPlay: () => setPlaying(true),
    onEnded: () => { setPlaying(false); finish(currentItem.id); },
    onError: () => setMediaError('Unable to load this media. It may no longer be available.'),
  };
  const iconButton = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 active:scale-95';
  const PlayIcon = playing ? Pause : Play;
  return (
    <section aria-label="Media player"
      className={cx('fixed bottom-[4.75rem] left-3 right-3 z-40 mx-auto overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-2xl backdrop-blur sm:bottom-4 sm:left-auto sm:right-5',
        minimized ? 'max-w-sm sm:w-80' : 'max-w-3xl sm:w-[min(42rem,calc(100vw-2rem))]')}>
      {minimized && <div className="h-0.5 bg-slate-100"><div className="h-full bg-voice transition-[width]" style={{ width: `${percent}%` }} /></div>}
      <div className={cx('flex items-center gap-2', minimized ? 'p-2' : 'px-3 pb-2 pt-3')}>
        <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white', currentItem.type === 'video' ? 'bg-gradient-to-br from-rose-500 to-pink-600' : 'bg-gradient-to-br from-violet-500 to-indigo-600')}>
          {currentItem.type === 'video' ? <Video className="h-4 w-4" /> : <Music className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{currentItem.title}</p>
          <p className="truncate text-xs text-slate-500">
            {currentItem.uploader || (currentItem.type === 'video' ? 'Video' : 'Audio')}
            {progress?.duration > 0 ? ` · ${formatTime(progress.currentTime)} / ${formatTime(progress.duration)}` : ''}
          </p>
        </div>
        {minimized ? (
          <button type="button" className={cx(iconButton, 'bg-voice text-white hover:bg-voice hover:text-white')} onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
            <PlayIcon className="h-4 w-4" fill="currentColor" />
          </button>
        ) : (
          <label className="hidden items-center gap-1 text-xs text-slate-500 sm:flex">Speed
            <select className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-700" value={playbackRate} onChange={event => setPlaybackRate(event.target.value)} aria-label="Playback speed">
              {SPEEDS.map(speed => <option key={speed} value={speed}>{speed}×</option>)}
            </select>
          </label>
        )}
        <button type="button" className={iconButton} onClick={() => setMinimized(value => !value)} aria-label={minimized ? 'Expand player' : 'Minimise player'} title={minimized ? 'Expand' : 'Minimise'}>
          {minimized ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        <button type="button" className={iconButton} onClick={closePlayer} aria-label="Close player" title="Close"><X className="h-4 w-4" /></button>
      </div>
      <div className={cx('px-3 pb-3', minimized && 'hidden')}>
        {mediaError && <p className="mb-2 text-xs text-rose-600">{mediaError}</p>}
        {currentItem.type === 'video' ? <video key={currentItem.id} {...mediaProps} playsInline className="max-h-56 w-full rounded-lg bg-black" />
          : <audio key={currentItem.id} {...mediaProps} className="hidden" />}
        {currentItem.type !== 'video' && (
          <div className="flex items-center gap-2 text-[11px] tabular-nums text-slate-500">
            <span className="w-9 text-right">{formatTime(progress?.currentTime || 0)}</span>
            <input type="range" min="0" max={progress?.duration || 0} step="0.1" value={progress?.currentTime || 0}
              onChange={event => { if (mediaRef.current) mediaRef.current.currentTime = Number(event.target.value); }}
              className="h-1.5 flex-1 cursor-pointer accent-brand-600" aria-label="Seek" />
            <span className="w-9">{formatTime(progress?.duration || 0)}</span>
          </div>
        )}
        <div className="mt-2 flex items-center justify-center gap-3">
          <button type="button" className={iconButton} onClick={() => skip(-SKIP_SECONDS)} aria-label={`Back ${SKIP_SECONDS} seconds`} title={`Back ${SKIP_SECONDS}s`}><RotateCcw className="h-4 w-4" /></button>
          {currentItem.type !== 'video' && (
            <button type="button" className={cx(iconButton, 'h-11 w-11 bg-voice text-white shadow-glow hover:bg-voice hover:text-white')} onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
              <PlayIcon className="h-5 w-5" fill="currentColor" />
            </button>
          )}
          <button type="button" className={iconButton} onClick={() => skip(SKIP_SECONDS)} aria-label={`Forward ${SKIP_SECONDS} seconds`} title={`Forward ${SKIP_SECONDS}s`}><RotateCw className="h-4 w-4" /></button>
          <select className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-700 sm:hidden" value={playbackRate} onChange={event => setPlaybackRate(event.target.value)} aria-label="Playback speed">
            {SPEEDS.map(speed => <option key={speed} value={speed}>{speed}×</option>)}
          </select>
        </div>
      </div>
      <span className="sr-only">Resume position: {formatTime(progress?.currentTime || 0)}</span>
    </section>
  );
}