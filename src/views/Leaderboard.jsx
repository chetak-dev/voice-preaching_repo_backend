import React from 'react';
import { Trophy } from 'lucide-react';
import { api } from '../api.js';
import { Avatar, EmptyState, ErrorBanner, PageHeader, Spinner, cx, useAsync } from '../components/ui.jsx';

const MEDALS = ['bg-amber-400 text-white', 'bg-slate-400 text-white', 'bg-orange-400 text-white'];

function Row({ entry, highlight }) {
  return (
    <div className={cx('flex items-center gap-3 px-4 py-3 sm:px-5', highlight && 'bg-violet-50')}>
      <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold', MEDALS[entry.rank - 1] || 'bg-slate-100 text-slate-600')}>
        {entry.rank || '–'}
      </span>
      <Avatar name={entry.name} size="sm" />
      <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{entry.name}{highlight && <span className="text-slate-500"> (you)</span>}</p>
      <span className="shrink-0 text-sm font-semibold text-slate-900">{entry.points.toLocaleString()} <span className="font-normal text-slate-500">pts</span></span>
    </div>
  );
}

export default function Leaderboard({ user }) {
  const { data, loading, error, reload } = useAsync(() => api('/leaderboard'), []);
  const inTop = data?.top.some(entry => entry.id === user.id);
  return (
    <div>
      <PageHeader title="Top 10" />
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && (
        <div className="space-y-4">
          {data.top.length ? (
            <div className="card divide-y divide-slate-100 overflow-hidden">
              {data.top.map(entry => <Row key={entry.id} entry={entry} highlight={entry.id === user.id} />)}
            </div>
          ) : <EmptyState icon={Trophy} title="No points yet" />}
          {!inTop && <div className="card overflow-hidden"><Row entry={data.me} highlight /></div>}
          <p className="text-center text-xs text-slate-500">{data.pointsPerApproval} points per approved submission</p>
        </div>
      )}
    </div>
  );
}
