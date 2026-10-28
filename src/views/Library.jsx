import React, { useCallback, useMemo, useState } from 'react';
import { ArrowDownWideNarrow, Bookmark, Clock, CornerDownLeft, Eye, FolderOpen, History, LayoutGrid, Layers, List, Loader2, MessageSquarePlus, Search, Trash2, TrendingUp, Undo2, UploadCloud, User, X } from 'lucide-react';
import { api } from '../api.js';
import { ContentCard, ContentThumb, PreviewModal, ShareButton, canShare, shareContent } from '../components/Content.jsx';
import { useMediaPlayer } from '../components/MediaPlayer.jsx';
import { useEffect, useRef } from 'react';
import {
  Badge, Button, EmptyState, ErrorBanner, Modal, PageHeader, STATUS_META, Spinner, TYPE_META, cx, timeAgo, useToast,
} from '../components/ui.jsx';
import { LIBRARY_TYPE_KEY } from './Overview.jsx';
import { onThumbnail } from '../uploads.js';
import { backfillThumbnails } from '../thumbnails.js';
import { LANGUAGES, useFacets } from '../components/Tags.jsx';

function formatResumeTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${minutes}:${String(rest).padStart(2, '0')}`;
}

const TITLES = { library: 'Library', saved: 'Saved', mine: 'My submissions' };

const RECENT_KEY = 'voice.recentSearches';
const DEEP_KEY = 'voice.searchInsideFiles';
const CACHE_MS = 60_000;
const SORT_KEY = 'voice.librarySort';
const SORTS = {
  newest: { label: 'Newest', compare: (a, b) => (b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : 0) },
  popular: { label: 'Most viewed', compare: (a, b) => (b.views || 0) - (a.views || 0) || (b.created_at > a.created_at ? 1 : -1) },
  title: { label: 'A–Z', compare: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }) },
  oldest: { label: 'Oldest', compare: (a, b) => (a.created_at > b.created_at ? 1 : a.created_at < b.created_at ? -1 : 0) },
};
// Highlight rows only appear once the library is big enough for them to differ from the grid below.
const SHELF_MIN_ITEMS = 8;
const SHELF_SIZE = 10;

function Shelf({ title, icon: Icon, items, renderCard }) {
  if (!items.length) return null;
  return (
    <section className="mb-6" aria-label={title}>
      <h2 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-slate-800">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Icon className="h-3.5 w-3.5" /></span>
        {title}
      </h2>
      <div className="no-scrollbar -mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:gap-3 sm:px-0">
        {items.map(item => renderCard(item, 'w-[44%] shrink-0 snap-start sm:w-48 lg:w-52'))}
      </div>
    </section>
  );
}
const loadRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } };

function Highlight({ text, query }) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (!query || index < 0) return text;
  return <>{text.slice(0, index)}<mark className="rounded bg-brand-100 px-0.5 text-brand-800">{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}

// Ranks title prefix matches first, then word starts, then anywhere in the title, uploader or description.
function rank(item, q) {
  const title = item.title.toLowerCase();
  if (title.startsWith(q)) return 0;
  if (title.includes(` ${q}`)) return 1;
  if (title.includes(q)) return 2;
  if (item.uploader?.toLowerCase().includes(q)) return 3;
  if (item.description?.toLowerCase().includes(q)) return 4;
  return -1;
}

function LayoutToggle({ layout, onChange, className }) {
  return (
    <div className={cx('shrink-0 rounded-xl bg-white p-1 ring-1 ring-inset ring-slate-200', className)}>
      {[['grid', LayoutGrid], ['list', List]].map(([key, Icon]) => (
        <button key={key} type="button" onClick={() => onChange(key)} aria-label={`${key} view`} aria-pressed={layout === key}
          className={cx('rounded-lg p-1.5', layout === key ? 'bg-brand-50 text-brand-700' : 'text-slate-400 hover:text-slate-600')}>
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}

function SearchBox({ query, onQuery, pool, onPick, busy, placeholder }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [recent, setRecent] = useState(loadRecent);
  const q = query.trim().toLowerCase();
  const box = useRef(null);
  const [room, setRoom] = useState(320);
  // Suggestions use the space left between the search box and the on-screen keyboard.
  useEffect(() => {
    if (!open) return undefined;
    const viewport = window.visualViewport;
    const measure = () => {
      const bottom = box.current?.getBoundingClientRect().bottom ?? 0;
      const height = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;
      setRoom(Math.max(160, Math.min(420, height - bottom - 16)));
    };
    measure();
    viewport?.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => { viewport?.removeEventListener('resize', measure); window.removeEventListener('scroll', measure); };
  }, [open]);
  function focused() {
    setOpen(true);
    // On phones, move the search box to the top so the suggestions are not hidden behind the keyboard.
    if (window.matchMedia('(max-width: 639px)').matches) setTimeout(() => box.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250);
  }

  const options = useMemo(() => {
    if (!q) return recent.map(text => ({ kind: 'recent', key: `r:${text}`, text }));
    const matches = pool.map(item => [item, rank(item, q)]).filter(([, score]) => score >= 0)
      .sort((a, b) => a[1] - b[1] || (b[0].views || 0) - (a[0].views || 0)).slice(0, 6)
      .map(([item]) => ({ kind: 'item', key: `i:${item.id}`, item }));
    const people = [...new Set(pool.map(item => item.uploader).filter(name => name?.toLowerCase().includes(q)))].slice(0, 3)
      .map(name => ({ kind: 'person', key: `p:${name}`, text: name, count: pool.filter(item => item.uploader === name).length }));
    return [...matches, ...people];
  }, [q, pool, recent]);

  const remember = text => {
    const value = text.trim();
    if (!value) return;
    const next = [value, ...recent.filter(entry => entry.toLowerCase() !== value.toLowerCase())].slice(0, 5);
    setRecent(next);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  };
  const clearRecent = () => { setRecent([]); try { localStorage.removeItem(RECENT_KEY); } catch { /* storage unavailable */ } };

  function choose(option) {
    if (option.kind === 'item') { remember(query); onPick(option.item); setOpen(false); return; }
    onQuery(option.text);
    remember(option.text);
    setActive(-1);
    setOpen(false);
  }

  function onKeyDown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      // Cycles through the options and back to the text box (-1).
      const total = options.length + 1;
      setActive(current => ((current + 1 + step + total) % total) - 1);
    } else if (event.key === 'Enter') {
      if (open && options[active]) { event.preventDefault(); choose(options[active]); } else { remember(query); setOpen(false); }
    } else if (event.key === 'Escape') {
      if (open) { event.preventDefault(); setOpen(false); }
    }
  }

  const show = open && options.length > 0;
  return (
    <div ref={box} className="relative min-w-0 flex-1 scroll-mt-[calc(4.5rem+env(safe-area-inset-top))]">
      {busy
        ? <Loader2 className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 animate-spin text-brand-500" aria-label="Searching" />
        : <Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-slate-400" />}
      <input className="input pl-9" type="search" placeholder={placeholder} aria-label="Search" autoComplete="off"
        role="combobox" aria-expanded={show} aria-controls="search-suggestions" aria-autocomplete="list"
        aria-activedescendant={show && options[active] ? `suggestion-${active}` : undefined}
        value={query} onChange={e => { onQuery(e.target.value); setActive(-1); setOpen(true); }}
        onFocus={focused} onBlur={() => setOpen(false)} onKeyDown={onKeyDown} />
      {show && (
        <div className="absolute inset-x-0 top-full z-30 mt-1.5 overflow-hidden rounded-xl bg-white shadow-xl ring-1 ring-slate-200">
          {!q && (
            <div className="flex items-center justify-between px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Recent
              <button type="button" onMouseDown={e => e.preventDefault()} onClick={clearRecent} className="normal-case tracking-normal text-brand-600 hover:underline">Clear</button>
            </div>
          )}
          <ul id="search-suggestions" role="listbox" aria-label="Suggestions" className="overflow-y-auto overscroll-contain py-1" style={{ maxHeight: room }}>
            {options.map((option, index) => {
              const meta = option.item && TYPE_META[option.item.type];
              const Icon = option.kind === 'recent' ? History : option.kind === 'person' ? User : meta.icon;
              return (
                <li key={option.key} id={`suggestion-${index}`} role="option" aria-selected={index === active}
                  onMouseDown={e => e.preventDefault()} onClick={() => choose(option)} onMouseEnter={() => setActive(index)}
                  className={cx('flex cursor-pointer items-center gap-3 px-3 py-2', index === active && 'bg-slate-50')}>
                  <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', meta ? meta.tone : 'bg-slate-100 text-slate-500')}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 block break-words text-sm font-medium leading-snug text-slate-900">
                      <Highlight text={option.item ? option.item.title : option.text} query={q} />
                    </span>
                    {option.kind === 'item' && <span className="block truncate text-xs text-slate-500">{meta.label} · {option.item.uploader}</span>}
                    {option.kind === 'person' && <span className="block truncate text-xs text-slate-500">{option.count} {option.count === 1 ? 'item' : 'items'}</span>}
                  </span>
                  {option.kind === 'item' && <CornerDownLeft className={cx('h-4 w-4 shrink-0 text-slate-300', index !== active && 'invisible')} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

const PAGE_SIZE = 24;
const FILTER_KEYS = ['language', 'chapter', 'speaker', 'topic'];
const NO_FILTERS = { language: '', chapter: '', speaker: '', topic: '' };

function useDebounced(value, delay) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export default function Library({ scope, user, navigate, onChanged, onAddTo, sharedContentId, onSharedOpened }) {
  const toast = useToast();
  const home = scope === 'library';
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 250);
  const [deep, setDeep] = useState(() => { try { return localStorage.getItem(DEEP_KEY) === '1'; } catch { return false; } });
  const changeDeep = value => { setDeep(value); try { localStorage.setItem(DEEP_KEY, value ? '1' : '0'); } catch { /* storage unavailable */ } };
  const [type, setType] = useState(() => {
    try {
      const picked = sessionStorage.getItem(LIBRARY_TYPE_KEY);
      sessionStorage.removeItem(LIBRARY_TYPE_KEY);
      return home && TYPE_META[picked] ? picked : 'all';
    } catch { return 'all'; }
  });
  const [status, setStatus] = useState('all');
  const [filters, setFilters] = useState(NO_FILTERS);
  const activeFilters = FILTER_KEYS.filter(key => filters[key]).length;
  const facets = useFacets();
  const [layout, setLayout] = useState('grid');
  const [sort, setSort] = useState(() => { try { return SORTS[localStorage.getItem(SORT_KEY)] ? localStorage.getItem(SORT_KEY) : 'newest'; } catch { return 'newest'; } });
  const changeSort = value => { setSort(value); try { localStorage.setItem(SORT_KEY, value); } catch { /* storage unavailable */ } };
  const [preview, setPreview] = useState(null);
  const [overrides, setOverrides] = useState({});
  const pickTag = (key, value) => {
    setFilters(current => ({ ...current, [key]: String(value) }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // The server filters, sorts and pages; more results load as the user scrolls.
  const params = useMemo(() => {
    const search = new URLSearchParams({ scope, sort });
    if (q) search.set('q', q);
    if (q && deep) search.set('in', 'all');
    if (type !== 'all') search.set('type', type);
    if (scope === 'mine' && status !== 'all') search.set('status', status);
    for (const key of FILTER_KEYS) if (filters[key]) search.set(key, filters[key]);
    return search.toString();
  }, [scope, sort, q, deep, type, status, filters]);
  const [list, setList] = useState({ params: null, items: [], total: 0, hasMore: false, counts: {}, loading: true, error: null });
  const [version, setVersion] = useState(0);
  // Recent result pages, so going back to an earlier search or filter is instant.
  const pageCache = useRef(null);
  if (!pageCache.current) pageCache.current = new Map();
  const reload = useCallback(() => { pageCache.current.clear(); setVersion(current => current + 1); }, []);
  useEffect(() => {
    const show = result => setList({ params, items: result.items, total: result.total, hasMore: result.hasMore, counts: result.counts || {}, loading: false, error: null });
    const cache = pageCache.current;
    const cached = cache.get(params);
    if (cached && Date.now() - cached.at < CACHE_MS) { show(cached.result); return undefined; }
    // Typing quickly starts several searches; only the latest one is kept.
    const controller = new AbortController();
    setList(current => ({ ...current, loading: true, error: null }));
    api(`/content?${params}&limit=${PAGE_SIZE}&offset=0`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        cache.set(params, { at: Date.now(), result });
        if (cache.size > 30) cache.delete(cache.keys().next().value);
        show(result);
      })
      .catch(err => { if (!controller.signal.aborted) setList(current => ({ ...current, loading: false, error: err })); });
    return () => controller.abort();
  }, [params, version]);
  const fetchingMore = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = useCallback(() => {
    if (fetchingMore.current || !list.hasMore || list.params !== params) return;
    fetchingMore.current = true;
    setLoadingMore(true);
    api(`/content?${params}&limit=${PAGE_SIZE}&offset=${list.items.length}`)
      .then(result => setList(current => (current.params !== params ? current : {
        ...current, total: result.total, hasMore: result.hasMore,
        items: [...current.items, ...result.items.filter(item => !current.items.some(old => old.id === item.id))],
      })))
      .catch(err => toast(err.message, 'error'))
      .finally(() => { fetchingMore.current = false; setLoadingMore(false); });
  }, [list, params, toast]);
  const sentinel = useRef(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !list.hasMore) return undefined;
    const observer = new IntersectionObserver(entries => { if (entries[0].isIntersecting) loadMore(); }, { rootMargin: '600px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore, list.hasMore]);
  const data = list.params ? list : null;
  const { loading, error } = list;

  const withOverrides = useCallback(rows => rows.map(item => ({ ...item, ...overrides[item.id] })), [overrides]);
  const items = useMemo(() => withOverrides(list.items), [list.items, withOverrides]);
  const { lastContentId, progressById, openPlayer, currentItem } = useMediaPlayer();
  const sharedOpenRef = useRef(null);
  const [lastPlayed, setLastPlayed] = useState(null);
  useEffect(() => {
    if (!home || !lastContentId) { setLastPlayed(null); return undefined; }
    let live = true;
    api(`/content/${encodeURIComponent(lastContentId)}`).then(({ item }) => live && setLastPlayed(item)).catch(() => live && setLastPlayed(null));
    return () => { live = false; };
  }, [home, lastContentId]);
  const continueItem = home && lastPlayed && currentItem?.id !== lastContentId && lastPlayed.status === 'approved'
    && ['audio', 'video'].includes(lastPlayed.type) && lastPlayed.visibility !== 'private' ? lastPlayed : null;
  const continueProgress = continueItem ? progressById[continueItem.id] : null;

  const markThumb = useCallback(id => setOverrides(current => ({ ...current, [id]: { ...current[id], has_thumb: 1 } })), []);
  useEffect(() => onThumbnail(markThumb), [markThumb]);
  useEffect(() => {
    if (!list.items.length) return undefined;
    const canSet = item => item.uploader_id === user.id || ['site_admin', 'org_admin'].includes(user.role);
    return backfillThumbnails(list.items.filter(canSet), markThumb);
  }, [list.items, user, markThumb]);

  useEffect(() => {
    if (!sharedContentId || !home || sharedOpenRef.current === sharedContentId) return;
    sharedOpenRef.current = sharedContentId;
    api(`/content/${encodeURIComponent(sharedContentId)}`)
      .then(({ item }) => {
        if (item.uploader_id !== user.id && (item.visibility === 'private' || item.status !== 'approved')) throw new Error('unavailable');
        openItem(item);
      })
      .catch(() => toast('This item is unavailable or private.', 'error'))
      .finally(() => onSharedOpened?.());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedContentId, home, toast]);
  const filtered = useMemo(() => items.filter(item => (scope !== 'saved' || item.bookmarked)
    && (scope !== 'library' || item.visibility !== 'private')), [items, scope]);

  const browsing = home && !q && type === 'all' && !activeFilters;
  const [shelfRows, setShelfRows] = useState(null);
  useEffect(() => {
    if (!home) return undefined;
    let live = true;
    Promise.all([api(`/content?scope=library&sort=newest&limit=${SHELF_SIZE}`), api(`/content?scope=library&sort=popular&limit=${SHELF_SIZE}`)])
      .then(([recent, popular]) => live && setShelfRows({ recent: recent.items, popular: popular.items.filter(item => item.views > 0), total: recent.total }))
      .catch(() => {});
    return () => { live = false; };
  }, [home, version]);
  const shelves = browsing && shelfRows && shelfRows.total >= SHELF_MIN_ITEMS
    ? { recent: withOverrides(shelfRows.recent), popular: withOverrides(shelfRows.popular) } : null;
  const counts = list.counts;
  const countAll = Object.values(counts).reduce((sum, value) => sum + value, 0);
  async function toggleBookmark(item) {
    try {
      const { bookmarked } = await api(`/content/${item.id}/bookmark`, { method: 'POST' });
      setOverrides(current => ({ ...current, [item.id]: { ...current[item.id], bookmarked } }));
      toast(bookmarked ? 'Saved to your collection.' : 'Removed from saved.');
    } catch (err) { toast(err.message, 'error'); }
  }

  function openItem(item) {
    setPreview(item);
    if (item.status !== 'approved') return;
    api(`/content/${item.id}/view`, { method: 'POST' })
      .then(({ views }) => {
        setOverrides(current => ({ ...current, [item.id]: { ...current[item.id], views } }));
        setPreview(current => (current?.id === item.id ? { ...current, views } : current));
      })
      .catch(() => {});
  }

  async function share(item) {
    const result = await shareContent(item);
    if (result === 'copied') toast('Link copied.');
  }

  const [removing, setRemoving] = useState(null);
  const remove = item => setRemoving(item);
  function removed() {
    toast('Content removed.');
    setRemoving(null);
    setPreview(null);
    reload();
    onChanged?.();
  }

  const canDelete = () => user.role === 'site_admin';
  const canWithdraw = item => item.uploader_id === user.id && item.status === 'pending';
  const [withdrawing, setWithdrawing] = useState(null);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  async function withdraw() {
    setWithdrawBusy(true);
    try {
      await api(`/content/${withdrawing.id}/withdraw`, { method: 'POST' });
      toast(`Withdrew "${withdrawing.title}".`);
      setWithdrawing(null);
      setPreview(null);
      reload();
      onChanged?.();
    } catch (err) { toast(err.message, 'error'); } finally { setWithdrawBusy(false); }
  }
  function edited(item, changes) {
    setOverrides(current => ({ ...current, [item.id]: { ...current[item.id], ...changes } }));
    setPreview(current => (current?.id === item.id ? { ...current, ...changes } : current));
    toast('Details updated.');
  }
  function merged(item, count) {
    toast(`Merged ${count} ${count === 1 ? 'card' : 'cards'} into “${item.title}”.`);
    reload();
    onChanged?.();
  }
  const cardFooter = item => {
    if (scope !== 'mine') return null;
    if (canDelete(item)) return <Button variant="ghost" size="sm" icon={Trash2} onClick={() => remove(item)} className="text-rose-600 hover:bg-rose-50 hover:text-rose-700">Remove</Button>;
    if (canWithdraw(item)) return <Button variant="ghost" size="sm" icon={Undo2} onClick={() => setWithdrawing(item)} className="text-slate-600 hover:bg-slate-100">Withdraw</Button>;
    return null;
  };
  const renderCard = (item, className) => (
    <ContentCard key={item.id} item={item} onPreview={openItem} onShare={share} showStatus={scope === 'mine'} className={className}
      onBookmark={item.status === 'approved' && !item.parent_id ? toggleBookmark : undefined} footer={cardFooter(item)} />
  );

  return (
    <div>
      <div className="hidden lg:block">
        <PageHeader title={TITLES[scope]}
          actions={<Button icon={UploadCloud} onClick={() => navigate('upload')}>Contribute</Button>} />
      </div>

      {continueItem && (
        <section className="mb-5 flex flex-col gap-3 rounded-2xl border border-brand-100 bg-brand-50 p-4 sm:flex-row sm:items-center sm:justify-between" aria-label="Continue listening">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Continue listening</p>
            <p className="mt-1 truncate text-sm font-semibold text-slate-900">{continueItem.title}</p>
            <p className="text-xs text-slate-600">Resume at {formatResumeTime(continueProgress?.currentTime || 0)}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => openPlayer(continueItem)}>Continue playing</Button>
        </section>
      )}

      <div className="mb-5 space-y-3">
        <div className="flex items-center gap-2">
          <SearchBox query={query} onQuery={setQuery} pool={filtered} onPick={openItem} busy={loading && Boolean(q)}
            placeholder={deep ? 'Search everything, even inside files' : 'Search titles & descriptions'} />
          {scope === 'mine' && (
            <select className="input hidden w-44 sm:block" value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="all">All statuses</option>
              {Object.entries(STATUS_META).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
            </select>
          )}
          <div className="relative hidden shrink-0 sm:block">
            <ArrowDownWideNarrow className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <select className="input w-40 pl-9" value={sort} onChange={e => changeSort(e.target.value)} aria-label="Sort by">
              {Object.entries(SORTS).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
            </select>
          </div>
          <LayoutToggle layout={layout} onChange={setLayout} className="hidden sm:flex" />
        </div>
        {/* Phones: content type, sort and layout share one row under the full-width search box. */}
        <div className="flex items-center gap-2 sm:hidden">
          <select className="input min-w-0 flex-1" value={type} onChange={e => setType(e.target.value)} aria-label="Content type">
            {['all', ...Object.keys(TYPE_META)].map(key => (
              <option key={key} value={key}>{key === 'all' ? 'All types' : TYPE_META[key].plural} ({key === 'all' ? countAll : counts[key] || 0})</option>
            ))}
          </select>
          <div className="relative min-w-0 flex-1">
            <ArrowDownWideNarrow className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <select className="input w-full pl-9" value={sort} onChange={e => changeSort(e.target.value)} aria-label="Sort by">
              {Object.entries(SORTS).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
            </select>
          </div>
          <LayoutToggle layout={layout} onChange={setLayout} className="flex" />
        </div>
        {scope === 'mine' && (
          <select className="input sm:hidden" value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="all">All statuses</option>
            {Object.entries(STATUS_META).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
          </select>
        )}
        {query.trim() && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>Search in</span>
            <div className="flex rounded-full bg-white p-0.5 ring-1 ring-inset ring-slate-200" role="radiogroup" aria-label="Search in">
              {[[false, 'Title & description'], [true, 'Inside files too']].map(([value, label]) => (
                <button key={label} type="button" role="radio" aria-checked={deep === value} onClick={() => changeDeep(value)}
                  className={cx('rounded-full px-3 py-1 font-medium transition', deep === value ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900')}>
                  {label}
                </button>
              ))}
            </div>
            {deep && <span className="text-slate-400">Slower: also reads the text inside documents.</span>}
          </div>
        )}
        {activeFilters > 0 && (
          <div className="grid grid-cols-2 gap-2 rounded-2xl bg-white p-3 ring-1 ring-inset ring-slate-200 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
            <select className="input" value={filters.language} onChange={e => setFilters(current => ({ ...current, language: e.target.value }))} aria-label="Language">
              <option value="">All languages</option>
              {LANGUAGES.map(language => <option key={language}>{language}</option>)}
            </select>
            <select className="input" value={filters.chapter} onChange={e => setFilters(current => ({ ...current, chapter: e.target.value }))} aria-label="Gita chapter">
              <option value="">All chapters</option>
              {Array.from({ length: 18 }, (_, index) => String(index + 1)).map(chapter => {
                const known = facets?.chapters.find(entry => entry.name === chapter);
                return <option key={chapter} value={chapter}>Chapter {chapter}{known ? ` (${known.count})` : ''}</option>;
              })}
            </select>
            <select className="input" value={filters.speaker} onChange={e => setFilters(current => ({ ...current, speaker: e.target.value }))} aria-label="Speaker">
              <option value="">All speakers</option>
              {filters.speaker && !facets?.speakers.some(entry => entry.name === filters.speaker) && <option value={filters.speaker}>{filters.speaker}</option>}
              {facets?.speakers.map(entry => <option key={entry.name} value={entry.name}>{entry.name} ({entry.count})</option>)}
            </select>
            <select className="input" value={filters.topic} onChange={e => setFilters(current => ({ ...current, topic: e.target.value }))} aria-label="Topic">
              <option value="">All topics</option>
              {filters.topic && !facets?.topics.some(entry => entry.name.toLowerCase() === filters.topic.toLowerCase()) && <option value={filters.topic}>{filters.topic}</option>}
              {facets?.topics.map(entry => <option key={entry.name} value={entry.name}>{entry.name} ({entry.count})</option>)}
            </select>
            <Button variant="ghost" size="sm" icon={X} onClick={() => setFilters(NO_FILTERS)}
              className="col-span-2 justify-self-end sm:col-span-1 sm:self-center">Clear</Button>
          </div>
        )}
        <div className="no-scrollbar hidden gap-1.5 overflow-x-auto sm:flex">
          {['all', ...Object.keys(TYPE_META)].map(key => (
            <button key={key} type="button" onClick={() => setType(key)}
              className={cx('whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium transition active:scale-95',
                type === key ? 'bg-voice text-white shadow-glow' : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50')}>
              {key === 'all' ? 'All' : TYPE_META[key].plural}
              <span className={cx('ml-1.5 text-xs', type === key ? 'text-white/80' : 'text-slate-400')}>
                {key === 'all' ? countAll : counts[key] || 0}
              </span>
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && !data && <Spinner variant={layout === 'grid' ? 'grid' : 'list'} rows={8} />}
      {data && !filtered.length && !loading && (
        <EmptyState
          icon={scope === 'saved' ? Bookmark : scope === 'mine' ? UploadCloud : FolderOpen}
          title={q || type !== 'all' || activeFilters || status !== 'all' ? 'No matching content' : scope === 'saved' ? 'Nothing saved yet' : scope === 'mine' ? 'No submissions yet' : 'The library is empty'}
          description={home && (q || activeFilters) ? 'Can’t find it? Ask for it and someone may upload it.' : undefined}
          action={home && (q || activeFilters)
            ? <Button variant="secondary" icon={MessageSquarePlus} onClick={() => navigate('requests')}>Request content</Button>
            : !q && !activeFilters && type === 'all' && scope !== 'saved' && <Button icon={UploadCloud} onClick={() => navigate('upload')}>Contribute</Button>}
        />
      )}

      {shelves && (
        <>
          <Shelf title="Recently added" icon={Clock} items={shelves.recent} renderCard={renderCard} />
          <Shelf title="Most viewed" icon={TrendingUp} items={shelves.popular} renderCard={renderCard} />
          <h2 className="mb-2.5 text-sm font-semibold text-slate-800">All content</h2>
        </>
      )}

      {filtered.length > 0 && layout === 'grid' && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5">
          {filtered.map(item => renderCard(item))}
        </div>
      )}

      {filtered.length > 0 && layout === 'list' && (
        <div className="card divide-y divide-slate-100">
          {filtered.map(item => {
            const meta = TYPE_META[item.type];
            return (
              <div key={item.id} className="flex items-center gap-4 px-4 py-3">
                <button type="button" onClick={() => openItem(item)} className="h-12 w-16 shrink-0 overflow-hidden rounded-md" aria-label={`Preview ${item.title}`}>
                  <ContentThumb item={item} className="h-full w-full [&_svg]:h-5 [&_svg]:w-5" />
                </button>
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => openItem(item)} className="block w-full truncate text-left text-sm font-medium text-slate-900 hover:text-brand-700">{item.title}</button>
                  <p className="flex items-center gap-1.5 truncate text-xs text-slate-500">
                    <span className="truncate">{item.parent_title ? `Added to: ${item.parent_title}` : `${item.uploader} · ${timeAgo(item.created_at)}`}</span>
                    {item.parts > 0 && <span className="inline-flex shrink-0 items-center gap-1">· <Layers className="h-3.5 w-3.5" />+{item.parts}</span>}
                    {item.status === 'approved' && <span className="inline-flex shrink-0 items-center gap-1">· <Eye className="h-3.5 w-3.5" />{item.views || 0}</span>}
                  </p>
                  {scope === 'mine' && item.status === 'rejected' && item.review_note && (
                    <p className="mt-1 line-clamp-2 text-xs text-rose-700"><span className="font-medium">Reviewer note:</span> {item.review_note}</p>
                  )}
                  {item.snippet && <p className="mt-1 line-clamp-2 text-xs italic text-slate-500">{item.snippet}</p>}
                </div>
                {canShare(item) && <ShareButton item={item} onShare={share} className="shrink-0 p-2" />}
                {item.status === 'approved' && !item.parent_id && (
                  <button type="button" onClick={() => toggleBookmark(item)}
                    aria-label={item.bookmarked ? 'Remove from saved' : 'Save'} aria-pressed={Boolean(item.bookmarked)}
                    className={cx('shrink-0 rounded-md p-2 transition active:scale-90', item.bookmarked ? 'text-brand-600' : 'text-slate-400 hover:text-slate-700')}>
                    <Bookmark className="h-4 w-4" fill={item.bookmarked ? 'currentColor' : 'none'} />
                  </button>
                )}
                <Badge tone={meta.tone} icon={meta.icon} className="hidden w-24 justify-center sm:inline-flex">{meta.label}</Badge>
                {scope === 'mine' && <Badge tone={STATUS_META[item.status].tone}>{STATUS_META[item.status].label}</Badge>}
                {scope === 'mine' && canDelete(item) && (
                  <Button variant="ghost" size="sm" icon={Trash2} onClick={() => remove(item)} aria-label="Remove" className="text-rose-600 hover:bg-rose-50" />
                )}
                {scope === 'mine' && !canDelete(item) && canWithdraw(item) && (
                  <Button variant="ghost" size="sm" icon={Undo2} onClick={() => setWithdrawing(item)} aria-label="Withdraw" title="Withdraw" className="text-slate-600 hover:bg-slate-100" />
                )}
              </div>
            );
          })}
        </div>
      )}

      {list.hasMore && <div ref={sentinel} className="flex justify-center py-6">{loadingMore && <Loader2 className="h-5 w-5 animate-spin text-slate-400" aria-label="Loading more" />}</div>}

      <PreviewModal item={preview} onShare={share} onClose={() => setPreview(null)} user={user} onPickTag={pickTag}
        onAddTo={target => { setPreview(null); onAddTo?.(target); }} onEdited={edited} onMerged={merged}
        actions={preview && (canDelete() ? (
          <Button variant="secondary" icon={Trash2} onClick={() => remove(preview)} className="text-rose-600">Remove</Button>
        ) : canWithdraw(preview) && (
          <Button variant="secondary" icon={Undo2} onClick={() => { setWithdrawing(preview); setPreview(null); }}>Withdraw</Button>
        ))} />
      <RemoveContentModal item={removing} onClose={() => setRemoving(null)} onRemoved={removed} />
      <Modal open={Boolean(withdrawing)} onClose={withdrawBusy ? () => {} : () => setWithdrawing(null)} size="sm" title="Withdraw submission?"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setWithdrawing(null)} disabled={withdrawBusy}>Keep it</Button>
            <Button variant="danger" icon={Undo2} loading={withdrawBusy} onClick={withdraw}>Withdraw</Button>
          </>
        )}>
        {withdrawing && (
          <p className="text-sm text-slate-600">
            <span className="font-semibold text-slate-900">{withdrawing.title}</span> will be taken out of the review queue and deleted, together with any files you added to it. You can upload it again later.
          </p>
        )}
      </Modal>
    </div>
  );
}

const CONFIRM_WORD = 'REMOVE';

// Removes one item, or several at once when `items` is given (site admins clearing duplicates).
export function RemoveContentModal({ item, items, defaultReason = '', onClose, onRemoved }) {
  const toast = useToast();
  const [reason, setReason] = useState(defaultReason);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const many = items?.length ? items : null;
  const key = many ? many.map(entry => entry.id).join() : item?.id;
  useEffect(() => { setReason(defaultReason); setTyped(''); }, [key, defaultReason]);
  const ready = reason.trim().length >= 5 && typed.trim() === CONFIRM_WORD;
  async function submit(event) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      if (many) onRemoved(await api('/content/bulk-remove', { method: 'POST', body: { ids: many.map(entry => entry.id), reason: reason.trim() } }));
      else { await api(`/content/${item.id}`, { method: 'DELETE', body: { reason: reason.trim() } }); onRemoved(); }
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal open={Boolean(many || item)} onClose={busy ? () => {} : onClose} size="sm" title={many ? `Remove ${many.length} ${many.length === 1 ? 'item' : 'items'} permanently?` : 'Remove content permanently?'}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" icon={Trash2} type="submit" form="remove-content-form" loading={busy} disabled={!ready}>{many ? `Remove ${many.length}` : 'Remove'}</Button>
        </>
      )}>
      {(many || item) && (
        <form id="remove-content-form" onSubmit={submit} className="space-y-4">
          <div className="rounded-xl bg-rose-50 px-3.5 py-3 text-sm text-rose-800">
            {many ? (
              <>
                <p>These will be deleted from the library and from Google Drive, with any files added to them. This cannot be undone.</p>
                <ul className="mt-2 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                  {many.map(entry => <li key={entry.id} className="break-words">{entry.title}</li>)}
                </ul>
              </>
            ) : (
              <p><span className="font-semibold">{item.title}</span> will be deleted from the library and from Google Drive{item.parts > 0 ? `, together with the ${item.parts} ${item.parts === 1 ? 'file' : 'files'} added to it` : ''}. This cannot be undone.</p>
            )}
          </div>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">Reason for removing</span>
            <textarea className="input min-h-[80px]" value={reason} onChange={e => setReason(e.target.value)} maxLength={500}
              placeholder="Explain why this content is being removed (saved in the activity log)" autoFocus />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">Type <span className="font-mono font-bold text-rose-600">{CONFIRM_WORD}</span> to confirm</span>
            <input className="input font-mono" value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label={`Type ${CONFIRM_WORD} to confirm`} />
          </label>
        </form>
      )}
    </Modal>
  );
}
