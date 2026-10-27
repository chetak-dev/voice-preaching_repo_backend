import React from 'react';
import { AlertTriangle, ArrowRight, BarChart3, Eye, HardDrive, Inbox } from 'lucide-react';
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

const shortDate = iso => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

function StatTile({ icon: Icon, label, value, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick}
      className={cx('card group flex items-center gap-3 p-4 text-left', onClick && 'transition hover:shadow-md active:scale-[0.98]')}>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Icon className="h-5 w-5" /></div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-slate-500">{label}</p>
        <p className="truncate text-lg font-bold leading-tight text-slate-900">{Number(value || 0).toLocaleString()}</p>
      </div>
      {onClick && <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-600" />}
    </Tag>
  );
}

function Panel({ title, children, className }) {
  return (
    <div className={cx('card p-4', className)}>
      <h3 className="mb-3 text-sm font-semibold text-slate-900">{title}</h3>
      {children}
    </div>
  );
}

function WeeklyChart({ weekly }) {
  const max = Math.max(1, ...weekly.map(week => week.uploads || 0));
  const total = weekly.reduce((sum, week) => sum + (week.uploads || 0), 0);
  return (
    <Panel title={`Uploads per week · ${total} in 12 weeks`}>
      <div className="flex h-32 items-end gap-1 sm:gap-1.5" role="img" aria-label="Uploads per week for the last 12 weeks">
        {weekly.map(week => {
          const count = week.uploads || 0;
          return (
            <div key={week.start} title={`Week of ${shortDate(week.start)}: ${count} ${count === 1 ? 'upload' : 'uploads'}`}
              className="flex h-full flex-1 items-end">
              <div className={cx('w-full rounded-t-md', count ? 'bg-brand-500 hover:bg-brand-600' : 'bg-slate-200')}
                style={{ height: count ? `${Math.max(4, (count / max) * 100)}%` : '2px' }} />
            </div>
          );
        })}
      </div>
      {weekly.length > 0 && (
        <div className="mt-1.5 flex justify-between text-[11px] text-slate-400">
          <span>{shortDate(weekly[0].start)}</span>
          <span>{shortDate(weekly[weekly.length - 1].start)}</span>
        </div>
      )}
    </Panel>
  );
}

function BarList({ items, empty = 'No data yet' }) {
  if (!items?.length) return <p className="text-xs text-slate-400">{empty}</p>;
  const max = Math.max(1, ...items.map(item => item.value || 0));
  return (
    <ul className="space-y-2">
      {items.map(item => (
        <li key={item.key} className="text-xs">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-slate-700" title={item.label}>{item.label}</span>
            <span className="shrink-0 font-semibold tabular-nums text-slate-900">{Number(item.value || 0).toLocaleString()}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.max(2, ((item.value || 0) / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function MostViewed({ items }) {
  return (
    <Panel title="Most viewed">
      {!items?.length ? <p className="text-xs text-slate-400">No views yet</p> : (
        <ol className="divide-y divide-slate-100">
          {items.map((item, index) => {
            const meta = TYPE_META[item.type] || TYPE_META.doc;
            return (
              <li key={item.id} className="flex items-center gap-2.5 py-1.5 text-xs">
                <span className="w-4 shrink-0 text-right font-semibold tabular-nums text-slate-400">{index + 1}</span>
                <span className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 ring-inset', meta.tone)}><meta.icon className="h-3.5 w-3.5" /></span>
                <span className="min-w-0 flex-1 truncate text-slate-700" title={item.title}>{item.title || 'Untitled'}</span>
                <span className="flex shrink-0 items-center gap-1 tabular-nums text-slate-500"><Eye className="h-3 w-3" />{Number(item.views || 0).toLocaleString()}</span>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

function Analytics({ analytics, navigate }) {
  const tags = list => (list || []).map(entry => ({ key: entry.name, label: entry.name, value: entry.count }));
  return (
    <section aria-label="Analytics">
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-slate-700"><BarChart3 className="h-4 w-4 text-slate-400" />Analytics</h2>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="grid grid-cols-2 gap-3 lg:col-span-2">
          <StatTile icon={Eye} label="Views (30 days)" value={analytics.viewsLast30} />
          <StatTile icon={Inbox} label="Open requests" value={analytics.openRequests}
            onClick={navigate ? () => navigate('requests') : undefined} />
        </div>
        <WeeklyChart weekly={analytics.weekly || []} />
        <Panel title="Top contributors">
          <BarList empty="No approved uploads yet"
            items={(analytics.topContributors || []).map(person => ({ key: person.id, label: person.name || 'Unknown', value: person.approved }))} />
        </Panel>
        <MostViewed items={analytics.topViewed} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <Panel title="Languages"><BarList items={tags(analytics.languages)} empty="No tags yet" /></Panel>
          <Panel title="Topics"><BarList items={tags(analytics.topics)} empty="No tags yet" /></Panel>
        </div>
      </div>
    </section>
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
          {data.analytics && <Analytics analytics={data.analytics} navigate={navigate} />}
        </div>
      )}
    </div>
  );
}
