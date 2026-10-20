import React from 'react';
import { History } from 'lucide-react';
import { api } from '../api.js';
import { Avatar, EmptyState, ErrorBanner, PageHeader, Spinner, timeAgo, useAsync } from '../components/ui.jsx';

const tone = action => (/approved/i.test(action) ? 'text-emerald-700' : /rejected|deleted|removed|revoked/i.test(action) ? 'text-rose-700' : 'text-slate-900');

export default function Activity() {
  const { data, loading, error, reload } = useAsync(() => api('/audit'), []);
  return (
    <div>
      <PageHeader title="Activity log" description="The latest 100 administrative and content events across the platform." />
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && !data.entries.length && <EmptyState icon={History} title="No activity yet" />}
      {data?.entries.length > 0 && (
        <div className="card divide-y divide-slate-100">
          {data.entries.map(entry => (
            <div key={entry.id} className="flex items-center gap-3 px-5 py-3">
              <Avatar name={entry.actor} size="sm" />
              <p className="min-w-0 flex-1 truncate text-sm text-slate-600">
                <span className="font-medium text-slate-900">{entry.actor}</span>{' '}
                <span className={tone(entry.action)}>{entry.action.toLowerCase()}</span>{' '}
                <span className="font-medium text-slate-800">{entry.subject}</span>
              </p>
              <time className="shrink-0 text-xs text-slate-400" dateTime={entry.created_at} title={new Date(entry.created_at).toLocaleString()}>{timeAgo(entry.created_at)}</time>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
