import React, { useCallback, useMemo, useState } from 'react';
import { ArrowDownWideNarrow, Bookmark, Clock, CornerDownLeft, Eye, FolderOpen, History, LayoutGrid, Layers, List, Search, Trash2, TrendingUp, Undo2, UploadCloud, User } from 'lucide-react';
import { api } from '../api.js';
import { ContentCard, ContentThumb, PreviewModal, ShareButton, canShare, shareContent } from '../components/Content.jsx';
import { useMediaPlayer } from '../components/MediaPlayer.jsx';
import { useEffect, useRef } from 'react';
import {
  Badge, Button, EmptyState, ErrorBanner, Modal, PageHeader, STATUS_META, Spinner, TYPE_META, cx, timeAgo, useAsync, useToast,
} from '../components/ui.jsx';
import { LIBRARY_TYPE_KEY } from './Overview.jsx';
import { onThumbnail } from '../uploads.js';
import { backfillThumbnails } from '../thumbnails.js';

function formatResumeTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${minutes}:${String(rest).padStart(2, '0')}`;
}

const TITLES = { library: 'Library', saved: 'Saved', mine: 'My submissions' };

const RECENT_KEY = 'voice.recentSearches';
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

function SearchBox({ query, onQuery, pool, onPick }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [recent, setRecent] = useState(loadRecent);
  const q = query.trim().toLowerCase();

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
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input className="input pl-9" type="search" placeholder="Search" aria-label="Search" autoComplete="off"
        role="combobox" aria-expanded={show} aria-controls="search-suggestions" aria-autocomplete="list"
        aria-activedescendant={show && options[active] ? `suggestion-${active}` : undefined}
        value={query} onChange={e => { onQuery(e.target.value); setActive(-1); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKeyDown} />
      {show && (
        <div className="absolute inset-x-0 top-full z-30 mt-1.5 overflow-hidden rounded-xl bg-white shadow-xl ring-1 ring-slate-200">
          {!q && (
            <div className="flex items-center justify-between px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Recent
              <button type="button" onMouseDown={e => e.preventDefault()} onClick={clearRecent} className="normal-case tracking-normal text-brand-600 hover:underline">Clear</button>
            </div>
          )}
          <ul id="search-suggestions" role="listbox" aria-label="Suggestions" className="max-h-80 overflow-y-auto py-1">
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
                    <span className="block truncate text-sm font-medium text-slate-900">
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

export default function Library({ scope, user, navigate, onChanged, onAddTo, sharedContentId }) {
  const toast = useToast();
  const home = scope === 'library';
  const { data, loading, error, reload } = useAsync(() => api(`/content?scope=${scope}`), [scope]);
  const [query, setQuery] = useState('');
  const [type, setType] = useState(() => {
    try {
      const picked = sessionStorage.getItem(LIBRARY_TYPE_KEY);
      sessionStorage.removeItem(LIBRARY_TYPE_KEY);
      return home && TYPE_META[picked] ? picked : 'all';
    } catch { return 'all'; }
  });
  const [status, setStatus] = useState('all');
  const [layout, setLayout] = useState('grid');
  const [sort, setSort] = useState(() => { try { return SORTS[localStorage.getItem(SORT_KEY)] ? localStorage.getItem(SORT_KEY) : 'newest'; } catch { return 'newest'; } });
  const changeSort = value => { setSort(value); try { localStorage.setItem(SORT_KEY, value); } catch { /* storage unavailable */ } };
  const [preview, setPreview] = useState(null);
  const [overrides, setOverrides] = useState({});

  const items = useMemo(() => (data?.items || []).map(item => ({ ...item, ...overrides[item.id] })), [data, overrides]);
  const { lastContentId, progressById, openPlayer, currentItem } = useMediaPlayer();
  const sharedOpenRef = useRef(null);
  const continueItem = home && currentItem?.id !== lastContentId ? items.find(item => item.id === lastContentId && ['audio', 'video'].includes(item.type) && item.visibility !== 'private') : null;
  const continueProgress = continueItem ? progressById[continueItem.id] : null;

  const markThumb = useCallback(id => setOverrides(current => ({ ...current, [id]: { ...current[id], has_thumb: 1 } })), []);
  useEffect(() => onThumbnail(markThumb), [markThumb]);
  useEffect(() => {
    if (!data) return undefined;
    const canSet = item => item.uploader_id === user.id || ['site_admin', 'org_admin'].includes(user.role);
    return backfillThumbnails(data.items.filter(canSet), markThumb);
  }, [data, user, markThumb]);

  useEffect(() => {
    if (!sharedContentId || !home || !data || sharedOpenRef.current === sharedContentId) return;
    sharedOpenRef.current = sharedContentId;
    const shared = items.find(item => item.id === sharedContentId && item.visibility !== 'private');
    if (shared) openItem(shared);
    else toast('This shared item is unavailable or private.', 'error');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedContentId, home, data, items, toast]);
  const visible = useMemo(() => items.filter(item => (scope !== 'saved' || item.bookmarked)
    && (scope !== 'library' || item.visibility !== 'private')), [items, scope]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return visible.filter(item => (type === 'all' || item.type === type)
      && (status === 'all' || item.status === status)
      && (!q || [item.title, item.description, item.uploader].some(value => value?.toLowerCase().includes(q))))
      .sort(SORTS[sort].compare);
  }, [visible, query, type, status, sort]);
  const shelves = useMemo(() => {
    if (!home || query.trim() || type !== 'all' || visible.length < SHELF_MIN_ITEMS) return null;
    return {
      recent: [...visible].sort(SORTS.newest.compare).slice(0, SHELF_SIZE),
      popular: [...visible].filter(item => item.views > 0).sort(SORTS.popular.compare).slice(0, SHELF_SIZE),
    };
  }, [home, query, type, visible]);
  const counts = useMemo(() => items.reduce((acc, item) => ({ ...acc, [item.type]: (acc[item.type] || 0) + 1 }), {}), [items]);

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
      <PageHeader title={TITLES[scope]}
        actions={<Button icon={UploadCloud} onClick={() => navigate('upload')} className="hidden lg:inline-flex">Contribute</Button>} />

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
          <SearchBox query={query} onQuery={setQuery} pool={visible} onPick={openItem} />
          {scope === 'mine' && (
            <select className="input hidden w-44 sm:block" value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="all">All statuses</option>
              {Object.entries(STATUS_META).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
            </select>
          )}
          <label className="relative flex shrink-0 self-stretch" title="Sort">
            <span className="flex w-[42px] items-center justify-center rounded-xl bg-white text-slate-500 ring-1 ring-inset ring-slate-200 sm:hidden" aria-hidden="true">
              <ArrowDownWideNarrow className="h-4 w-4" />
            </span>
            <ArrowDownWideNarrow className="pointer-events-none absolute left-3 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-slate-400 sm:block" />
            <select className="input absolute inset-0 h-full w-full cursor-pointer opacity-0 sm:static sm:w-40 sm:pl-9 sm:opacity-100" value={sort}
              onChange={e => changeSort(e.target.value)} aria-label="Sort by">
              {Object.entries(SORTS).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
            </select>
          </label>
          <div className="flex shrink-0 rounded-xl bg-white p-1 ring-1 ring-inset ring-slate-200">
            {[['grid', LayoutGrid], ['list', List]].map(([key, Icon]) => (
              <button key={key} type="button" onClick={() => setLayout(key)} aria-label={`${key} view`} aria-pressed={layout === key}
                className={cx('rounded-lg p-1.5', layout === key ? 'bg-brand-50 text-brand-700' : 'text-slate-400 hover:text-slate-600')}>
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
        </div>
        {scope === 'mine' && (
          <select className="input sm:hidden" value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="all">All statuses</option>
            {Object.entries(STATUS_META).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
          </select>
        )}
        <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
          {['all', ...Object.keys(TYPE_META)].map(key => (
            <button key={key} type="button" onClick={() => setType(key)}
              className={cx('whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium transition active:scale-95',
                type === key ? 'bg-voice text-white shadow-glow' : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50')}>
              {key === 'all' ? 'All' : TYPE_META[key].plural}
              <span className={cx('ml-1.5 text-xs', type === key ? 'text-white/80' : 'text-slate-400')}>
                {key === 'all' ? items.length : counts[key] || 0}
              </span>
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && !data && <Spinner variant={layout === 'grid' ? 'grid' : 'list'} rows={8} />}
      {data && !filtered.length && (
        <EmptyState
          icon={scope === 'saved' ? Bookmark : scope === 'mine' ? UploadCloud : FolderOpen}
          title={items.length ? 'No matching content' : scope === 'saved' ? 'Nothing saved yet' : scope === 'mine' ? 'No submissions yet' : 'The library is empty'}
          action={!items.length && scope !== 'saved' && <Button icon={UploadCloud} onClick={() => navigate('upload')}>Contribute</Button>}
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

      <PreviewModal item={preview} onShare={share} onClose={() => setPreview(null)} user={user}
        onAddTo={target => { setPreview(null); onAddTo?.(target); }} onEdited={edited}
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

function RemoveContentModal({ item, onClose, onRemoved }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReason(''); setTyped(''); }, [item?.id]);
  const ready = reason.trim().length >= 5 && typed.trim() === CONFIRM_WORD;
  async function submit(event) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      await api(`/content/${item.id}`, { method: 'DELETE', body: { reason: reason.trim() } });
      onRemoved();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal open={Boolean(item)} onClose={busy ? () => {} : onClose} size="sm" title="Remove content permanently?"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" icon={Trash2} type="submit" form="remove-content-form" loading={busy} disabled={!ready}>Remove</Button>
        </>
      )}>
      {item && (
        <form id="remove-content-form" onSubmit={submit} className="space-y-4">
          <div className="rounded-xl bg-rose-50 px-3.5 py-3 text-sm text-rose-800">
            <p><span className="font-semibold">{item.title}</span> will be deleted from the library and from Google Drive{item.parts > 0 ? `, together with the ${item.parts} ${item.parts === 1 ? 'file' : 'files'} added to it` : ''}. This cannot be undone.</p>
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
