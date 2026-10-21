import React, { useMemo, useState } from 'react';
import { Bookmark, BookmarkCheck, Eye, FolderOpen, HardDrive, LayoutGrid, List, Search, Trash2, UploadCloud } from 'lucide-react';
import { api } from '../api.js';
import { ContentCard, ContentThumb, PreviewModal, ShareButton, canShare, shareContent } from '../components/Content.jsx';
import { useMediaPlayer } from '../components/MediaPlayer.jsx';
import { useEffect, useRef } from 'react';
import {
  Badge, Button, EmptyState, ErrorBanner, PageHeader, STATUS_META, Spinner, TYPE_META, cx, formatBytes, timeAgo, useAsync, useToast,
} from '../components/ui.jsx';

function formatResumeTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${minutes}:${String(rest).padStart(2, '0')}`;
}

const TITLES = { library: 'Library', saved: 'Saved', mine: 'My submissions' };

function TypeTile({ type, info, active, onClick }) {
  const meta = TYPE_META[type];
  return (
    <button type="button" onClick={onClick}
      className={cx('card flex items-center gap-3 p-3 text-left transition hover:shadow-md active:scale-[0.98]', active && 'ring-2 ring-brand-500')}>
      <div className={cx('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-sm', meta.tile)}><meta.icon className="h-5 w-5" /></div>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-slate-500">{meta.plural}</p>
        <p className="truncate text-base font-bold leading-tight text-slate-900">
          {type === 'link' ? info.files : formatBytes(info.bytes)}
        </p>
        <p className="truncate text-[11px] text-slate-400">{type === 'link' ? (info.files === 1 ? 'link' : 'links') : `${info.files} ${info.files === 1 ? 'item' : 'items'}`}</p>
      </div>
    </button>
  );
}

function StorageCard({ storage }) {
  const hasQuota = storage.total != null;
  const percent = hasQuota && storage.total > 0 ? Math.min(100, Math.round((storage.used / storage.total) * 100)) : 0;
  return (
    <div className="card flex items-center gap-3 p-3 2xl:col-span-2">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-slate-600 to-slate-800 text-white shadow-sm"><HardDrive className="h-5 w-5" /></div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900">Storage</p>
          <p className="truncate text-xs text-slate-500">{storage.drives} {storage.drives === 1 ? 'Drive' : 'Drives'}</p>
        </div>
        {hasQuota ? (
          <>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
              <div className={cx('h-full rounded-full', percent > 90 ? 'bg-rose-500' : percent > 75 ? 'bg-amber-500' : 'bg-voice')} style={{ width: `${percent}%` }} />
            </div>
            <p className="mt-1 truncate text-xs text-slate-500">{formatBytes(Math.max(0, storage.total - storage.used))} free of {formatBytes(storage.total)}</p>
          </>
        ) : (
          <p className="mt-0.5 truncate text-xs text-slate-500">{formatBytes(storage.content)} used</p>
        )}
      </div>
    </div>
  );
}

export default function Library({ scope, user, navigate, onChanged, sharedContentId }) {
  const toast = useToast();
  const home = scope === 'library';
  const { data, loading, error, reload } = useAsync(() => api(`/content?scope=${scope}`), [scope]);
  const overview = useAsync(() => (home ? api('/overview') : Promise.resolve(null)), [home]);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [layout, setLayout] = useState('grid');
  const [preview, setPreview] = useState(null);
  const [overrides, setOverrides] = useState({});

  const items = useMemo(() => (data?.items || []).map(item => ({ ...item, ...overrides[item.id] })), [data, overrides]);
  const { lastContentId, progressById, openPlayer } = useMediaPlayer();
  const sharedOpenRef = useRef(null);
  const continueItem = home ? items.find(item => item.id === lastContentId && ['audio', 'video'].includes(item.type) && item.visibility !== 'private') : null;
  const continueProgress = continueItem ? progressById[continueItem.id] : null;

  useEffect(() => {
    if (!sharedContentId || !home || !data || sharedOpenRef.current === sharedContentId) return;
    sharedOpenRef.current = sharedContentId;
    const shared = items.find(item => item.id === sharedContentId && item.visibility !== 'private');
    if (shared) openItem(shared);
    else toast('This shared item is unavailable or private.', 'error');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedContentId, home, data, items, toast]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(item => (scope !== 'saved' || item.bookmarked)
      && (scope !== 'library' || item.visibility !== 'private')
      && (type === 'all' || item.type === type)
      && (status === 'all' || item.status === status)
      && (!q || [item.title, item.description, item.uploader].some(value => value?.toLowerCase().includes(q))));
  }, [items, query, type, status, scope]);
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

  async function remove(item) {
    if (!window.confirm(`Delete "${item.title}"? This cannot be undone.`)) return;
    try {
      await api(`/content/${item.id}`, { method: 'DELETE' });
      toast('Submission deleted.');
      setPreview(null);
      reload();
      onChanged?.();
    } catch (err) { toast(err.message, 'error'); }
  }

  const canDelete = item => user.role === 'site_admin' || (item.uploader_id === user.id && item.status !== 'approved');
  const stats = overview.data;

  return (
    <div>
      <PageHeader title={TITLES[scope]}
        actions={<Button icon={UploadCloud} onClick={() => navigate('upload')} className="hidden lg:inline-flex">Contribute</Button>} />

      {home && stats?.types && (
        <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-7" aria-label="Library summary">
          {Object.keys(TYPE_META).map(key => (
            <TypeTile key={key} type={key} info={stats.types[key] || { files: 0, bytes: 0 }} active={type === key}
              onClick={() => setType(current => (current === key ? 'all' : key))} />
          ))}
          {stats.storage && <StorageCard storage={stats.storage} />}
        </section>
      )}

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
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="input pl-9" type="search" placeholder="Search" aria-label="Search"
              value={query} onChange={e => setQuery(e.target.value)} />
          </div>
          {scope === 'mine' && (
            <select className="input hidden w-44 sm:block" value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="all">All statuses</option>
              {Object.entries(STATUS_META).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
            </select>
          )}
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
        <div className={cx('no-scrollbar flex gap-1.5 overflow-x-auto', home && stats?.types && 'hidden')}>
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
      {loading && !data && <Spinner />}
      {data && !filtered.length && (
        <EmptyState
          icon={scope === 'saved' ? Bookmark : scope === 'mine' ? UploadCloud : FolderOpen}
          title={items.length ? 'No matching content' : scope === 'saved' ? 'Nothing saved yet' : scope === 'mine' ? 'No submissions yet' : 'The library is empty'}
          action={!items.length && scope !== 'saved' && <Button icon={UploadCloud} onClick={() => navigate('upload')}>Contribute</Button>}
        />
      )}

      {filtered.length > 0 && layout === 'grid' && (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filtered.map(item => (
            <ContentCard key={item.id} item={item} onPreview={openItem} onShare={share} showStatus={scope === 'mine'}
              onBookmark={item.status === 'approved' ? toggleBookmark : undefined}
              footer={scope === 'mine' && canDelete(item) && (
                <Button variant="ghost" size="sm" icon={Trash2} onClick={() => remove(item)} className="text-rose-600 hover:bg-rose-50 hover:text-rose-700">Delete</Button>
              )} />
          ))}
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
                  <button type="button" onClick={() => openItem(item)} className="block truncate text-left text-sm font-medium text-slate-900 hover:text-brand-700">{item.title}</button>
                  <p className="flex items-center gap-1.5 truncate text-xs text-slate-500">
                    <span className="truncate">{item.uploader} · {timeAgo(item.created_at)}</span>
                    {item.status === 'approved' && <span className="inline-flex shrink-0 items-center gap-1">· <Eye className="h-3.5 w-3.5" />{item.views || 0}</span>}
                  </p>
                  {scope === 'mine' && item.status === 'rejected' && item.review_note && (
                    <p className="mt-1 line-clamp-2 text-xs text-rose-700"><span className="font-medium">Reviewer note:</span> {item.review_note}</p>
                  )}
                </div>
                {canShare(item) && <ShareButton item={item} onShare={share} className="shrink-0 p-2" />}
                {item.status === 'approved' && (
                  <button type="button" onClick={() => toggleBookmark(item)}
                    aria-label={item.bookmarked ? 'Remove from saved' : 'Save'}
                    className={cx('shrink-0 rounded-md p-2 transition', item.bookmarked ? 'text-brand-600' : 'text-slate-400 hover:text-slate-700')}>
                    {item.bookmarked ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
                  </button>
                )}
                <Badge tone={meta.tone} icon={meta.icon} className="hidden w-24 justify-center sm:inline-flex">{meta.label}</Badge>
                {scope === 'mine' && <Badge tone={STATUS_META[item.status].tone}>{STATUS_META[item.status].label}</Badge>}
                {scope === 'mine' && canDelete(item) && (
                  <Button variant="ghost" size="sm" icon={Trash2} onClick={() => remove(item)} aria-label="Delete" className="text-rose-600 hover:bg-rose-50" />
                )}
              </div>
            );
          })}
        </div>
      )}

      <PreviewModal item={preview} onShare={share} onClose={() => setPreview(null)}
        actions={preview && user.role === 'site_admin' && scope === 'library' && (
          <Button variant="secondary" icon={Trash2} onClick={() => remove(preview)} className="text-rose-600">Remove</Button>
        )} />
    </div>
  );
}
