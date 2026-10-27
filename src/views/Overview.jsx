import React from 'react';
import { AlertTriangle, ArrowRight, HardDrive } from 'lucide-react';
import { api } from '../api.js';
import { ErrorBanner, PageHeader, Spinner, TYPE_META, cx, formatBytes, useAsync } from '../components/ui.jsx';

export const LIBRARY_TYPE_KEY = 'voice.libraryType';

function TypeTile({ type, info, onClick }) {
  const meta = TYPE_META[type];
  return (
    <button type="button" onClick={onClick}
      className="card group flex items-center gap-3 p-4 text-left transition hover:shadow-md active:scale-[0.98]">
      <div className={cx('flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-sm', meta.tile)}><meta.icon className="h-5 w-5" /></div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-slate-500">{meta.plural}</p>
        <p className="truncate text-lg font-bold leading-tight text-slate-900">
          {type === 'link' ? info.files : formatBytes(info.bytes)}
        </p>
        <p className="truncate text-[11px] text-slate-400">{type === 'link' ? (info.files === 1 ? 'link' : 'links') : `${info.files} ${info.files === 1 ? 'item' : 'items'}`}</p>
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-600" />
    </button>
  );
}

function StorageCard({ storage }) {
  const hasQuota = storage.total != null;
  const percent = hasQuota && storage.total > 0 ? Math.min(100, Math.round((storage.used / storage.total) * 100)) : 0;
  return (
    <div className="card flex items-center gap-4 p-5">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-slate-600 to-slate-800 text-white shadow-sm"><HardDrive className="h-5 w-5" /></div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900">Storage</p>
          <p className="truncate text-xs text-slate-500">{storage.drives} {storage.drives === 1 ? 'Drive' : 'Drives'}</p>
        </div>
        {hasQuota ? (
          <>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
              <div className={cx('h-full rounded-full', percent > 90 ? 'bg-rose-500' : percent > 75 ? 'bg-amber-500' : 'bg-voice')} style={{ width: `${percent}%` }} />
            </div>
            <p className="mt-1.5 truncate text-xs text-slate-500">
              {formatBytes(storage.content)} of content · {formatBytes(Math.max(0, storage.total - storage.used))} free of {formatBytes(storage.total)} ({percent}% used)
            </p>
          </>
        ) : (
          <p className="mt-0.5 truncate text-xs text-slate-500">{formatBytes(storage.content)} used</p>
        )}
      </div>
    </div>
  );
}

export default function Overview({ navigate }) {
  const { data, loading, error, reload } = useAsync(() => api('/overview'), []);
  const openType = type => {
    try { sessionStorage.setItem(LIBRARY_TYPE_KEY, type); } catch { /* storage unavailable */ }
    navigate('library');
  };
  return (
    <div>
      <PageHeader title="Overview" />
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data?.types && (
        <div className="space-y-6">
          {data.storage?.nearlyFull?.length > 0 && (
            <div role="alert" className="flex items-start gap-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
              <div className="min-w-0">
                <p className="font-semibold">Storage is running low</p>
                <p className="mt-0.5 text-amber-800">
                  {data.storage.nearlyFull.map(node => `${node.name} (${node.percent}% used)`).join(', ')}.
                  {' '}New uploads automatically go to the Drive with the most free space. Connect another Drive under Storage before all of them fill up.
                </p>
              </div>
            </div>
          )}
          {data.storage && <StorageCard storage={data.storage} />}
          <section aria-label="Library by type">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">Published content by type</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {Object.keys(TYPE_META).map(key => (
                <TypeTile key={key} type={key} info={data.types[key] || { files: 0, bytes: 0 }} onClick={() => openType(key)} />
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
