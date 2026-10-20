import React, { useMemo, useState } from 'react';
import { Bookmark, Clock, FolderOpen, LayoutGrid, List, Search, Trash2, UploadCloud, Users } from 'lucide-react';
import { api } from '../api.js';
import { ContentCard, ContentThumb, PreviewModal } from '../components/Content.jsx';
import {
  Badge, Button, EmptyState, ErrorBanner, PageHeader, STATUS_META, Spinner, TYPE_META, cx, timeAgo, useAsync, useToast,
} from '../components/ui.jsx';

const COPY = {
  library: { title: 'Library', description: 'Approved content shared with the whole community.' },
  saved: { title: 'Saved', description: 'Content you have bookmarked for quick access.' },
  mine: { title: 'My submissions', description: 'Track the review status of everything you have contributed.' },
};

function Stat({ icon: Icon, label, value, tone }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-white/10 p-3 ring-1 ring-white/20 backdrop-blur-sm sm:p-4">
      <div className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md', tone)}><Icon className="h-5 w-5" /></div>
      <div className="min-w-0">
        <p className="text-xl font-bold leading-tight text-white sm:text-2xl">{value ?? '—'}</p>
        <p className="truncate text-xs font-medium text-white/75">{label}</p>
      </div>
    </div>
  );
}

export default function Library({ scope, user, navigate, onChanged }) {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api(`/content?scope=${scope}`), [scope]);
  const overview = useAsync(() => (scope === 'library' ? api('/overview') : Promise.resolve(null)), [scope]);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [layout, setLayout] = useState('grid');
  const [preview, setPreview] = useState(null);
  const [overrides, setOverrides] = useState({});

  const items = useMemo(() => (data?.items || []).map(item => ({ ...item, ...overrides[item.id] })), [data, overrides]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(item => (scope !== 'saved' || item.bookmarked)
      && (type === 'all' || item.type === type)
      && (status === 'all' || item.status === status)
      && (!q || [item.title, item.description, item.uploader].some(value => value?.toLowerCase().includes(q))));
  }, [items, query, type, status, scope]);
  const counts = useMemo(() => items.reduce((acc, item) => ({ ...acc, [item.type]: (acc[item.type] || 0) + 1 }), {}), [items]);

  async function toggleBookmark(item) {
    try {
      const { bookmarked } = await api(`/content/${item.id}/bookmark`, { method: 'POST' });
      setOverrides(current => ({ ...current, [item.id]: { bookmarked } }));
      toast(bookmarked ? 'Saved to your collection.' : 'Removed from saved.');
    } catch (err) { toast(err.message, 'error'); }
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

  const isAdmin = user.role === 'site_admin' || user.role === 'org_admin';
  const canDelete = item => user.role === 'site_admin' || (item.uploader_id === user.id && item.status !== 'approved');
  const stats = overview.data;

  return (
    <div>
      {scope === 'library' ? (
        <section className="relative mb-6 overflow-hidden rounded-3xl bg-voice p-5 text-white shadow-glow sm:p-8">
          <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-white/10 blur-2xl" />
          <div className="pointer-events-none absolute -bottom-24 left-1/3 h-64 w-64 rounded-full bg-amber-300/20 blur-3xl" />
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-medium text-white/75">Welcome back,</p>
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{user.name.split(' ')[0]}</h1>
              <p className="mt-1 max-w-xl text-sm text-white/80">Discover approved lectures, audio, documents and links shared by the community.</p>
            </div>
            <Button variant="secondary" icon={UploadCloud} onClick={() => navigate('upload')}
              className="hidden !text-brand-700 !ring-0 lg:inline-flex">Contribute</Button>
          </div>
          <div className="relative mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat icon={FolderOpen} label="Published" value={stats?.approved} tone="from-violet-400 to-indigo-500" />
            <Stat icon={UploadCloud} label="My uploads" value={stats?.contributions} tone="from-sky-400 to-blue-500" />
            <Stat icon={Clock} label={isAdmin ? 'To review' : 'Pending'} value={stats?.pending} tone="from-amber-400 to-orange-500" />
            <Stat icon={Users} label="Members" value={stats?.members} tone="from-emerald-400 to-teal-500" />
          </div>
        </section>
      ) : (
        <PageHeader title={COPY[scope].title} description={COPY[scope].description}
          actions={<Button icon={UploadCloud} onClick={() => navigate('upload')} className="hidden lg:inline-flex">Contribute</Button>} />
      )}

      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative flex-1 lg:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9" placeholder="Search by title, description, or contributor" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
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
        {scope === 'mine' && (
          <select className="input lg:w-44" value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="all">All statuses</option>
            {Object.entries(STATUS_META).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
          </select>
        )}
        <div className="hidden self-start rounded-xl bg-white p-0.5 ring-1 ring-inset ring-slate-200 sm:flex lg:ml-auto lg:self-auto">
          {[['grid', LayoutGrid], ['list', List]].map(([key, Icon]) => (
            <button key={key} type="button" onClick={() => setLayout(key)} aria-label={`${key} view`}
              className={cx('rounded-lg p-1.5', layout === key ? 'bg-brand-50 text-brand-700' : 'text-slate-400 hover:text-slate-600')}>
              <Icon className="h-4 w-4" />
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
          description={items.length ? 'Try a different search or filter.'
            : scope === 'saved' ? 'Use the bookmark icon on any library item to keep it here.'
              : 'Contributions appear here once an admin approves them.'}
          action={!items.length && scope !== 'saved' && <Button icon={UploadCloud} onClick={() => navigate('upload')}>Contribute content</Button>}
        />
      )}

      {filtered.length > 0 && layout === 'grid' && (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filtered.map(item => (
            <ContentCard key={item.id} item={item} onPreview={setPreview} showStatus={scope === 'mine'}
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
                <button type="button" onClick={() => setPreview(item)} className="h-12 w-16 shrink-0 overflow-hidden rounded-md" aria-label={`Preview ${item.title}`}>
                  <ContentThumb item={item} className="h-full w-full [&_svg]:h-5 [&_svg]:w-5" />
                </button>
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => setPreview(item)} className="block truncate text-left text-sm font-medium text-slate-900 hover:text-brand-700">{item.title}</button>
                  <p className="truncate text-xs text-slate-500">{item.uploader} · {timeAgo(item.created_at)}</p>
                </div>
                <Badge tone={meta.tone} icon={meta.icon} className="hidden sm:inline-flex">{meta.label}</Badge>
                {scope === 'mine' && <Badge tone={STATUS_META[item.status].tone}>{STATUS_META[item.status].label}</Badge>}
                {scope === 'mine' && canDelete(item) && (
                  <Button variant="ghost" size="sm" icon={Trash2} onClick={() => remove(item)} aria-label="Delete" className="text-rose-600 hover:bg-rose-50" />
                )}
              </div>
            );
          })}
        </div>
      )}

      <PreviewModal item={preview} onClose={() => setPreview(null)}
        actions={preview && user.role === 'site_admin' && scope === 'library' && (
          <Button variant="secondary" icon={Trash2} onClick={() => remove(preview)} className="text-rose-600">Remove</Button>
        )} />
    </div>
  );
}
