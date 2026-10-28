import React, { useState, useSyncExternalStore } from 'react';
import { AlertCircle, Ban, CheckCircle2, ChevronDown, CloudOff, Loader2, UploadCloud, X } from 'lucide-react';
import { canCancel, cancel, dismissFinished, getJobs, isActive, subscribe } from '../uploads.js';
import { cx, formatBytes } from './ui.jsx';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function StatusIcon({ job }) {
  if (job.status === 'done') return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-label="Submitted" />;
  if (job.status === 'error') return <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" aria-label="Failed" />;
  if (job.status === 'cancelled') return <Ban className="h-4 w-4 shrink-0 text-slate-400" aria-label="Cancelled" />;
  if (job.status === 'waiting') return <CloudOff className="h-4 w-4 shrink-0 text-amber-600" aria-label="Waiting for connection" />;
  if (job.status === 'uploading') return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-600" aria-label="Uploading" />;
  return <span className="h-4 w-4 shrink-0 rounded-full border-2 border-slate-300" aria-label="Queued" />;
}

// Shows background uploads anywhere in the app; `inline` renders it as a card inside a page instead of floating.
export default function UploadTray({ inline = false }) {
  const jobs = useSyncExternalStore(subscribe, getJobs);
  const [open, setOpen] = useState(false);
  if (!jobs.length) return null;

  const active = jobs.filter(isActive);
  const failed = jobs.filter(job => job.status === 'error');
  const done = jobs.filter(job => job.status === 'done').length;
  const stopped = jobs.filter(job => job.status === 'cancelled').length;
  const counted = jobs.filter(job => job.status !== 'cancelled');
  const waiting = active.some(job => job.status === 'waiting');
  const weight = job => job.size || 1;
  const progress = counted.length ? Math.round(counted.reduce((sum, job) => sum + weight(job) * (job.status === 'done' ? 100 : job.progress), 0)
    / counted.reduce((sum, job) => sum + weight(job), 0)) : 0;

  const published = jobs.some(job => job.published);
  const title = active.length
    ? waiting ? 'Waiting for connection…' : `Uploading ${Math.min(done + failed.length + 1, counted.length)} of ${counted.length}`
    : failed.length ? `${plural(failed.length, 'upload')} failed`
      : done ? `${plural(done, 'upload')} ${published ? 'published' : 'submitted for review'}` : `${plural(stopped, 'upload')} cancelled`;
  const hint = active.length
    ? 'Keep using Kalpa Taru freely. If you close it, uploads continue the next time you open it.'
    : failed.length ? 'Open the list for details, then upload those files again.'
      : !done ? 'Nothing was uploaded.' : published ? 'They are live in the library now.' : 'They will appear in the library after approval.';

  return (
    <div className={cx('card overflow-hidden', inline ? 'mb-4' : 'fixed bottom-24 right-4 z-40 w-[min(22rem,calc(100vw-2rem))] shadow-pop animate-fade-in lg:bottom-6 lg:right-6')}
      role="status" aria-live="polite">
      <div className="flex items-center gap-3 p-3">
        <div className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
          active.length ? 'bg-brand-50 text-brand-600' : failed.length ? 'bg-rose-50 text-rose-600' : done ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500')}>
          {active.length ? <UploadCloud className="h-5 w-5" /> : failed.length ? <AlertCircle className="h-5 w-5" /> : done ? <CheckCircle2 className="h-5 w-5" /> : <Ban className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{title}</p>
          <p className="text-xs text-slate-500">{hint}</p>
        </div>
        <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-label={open ? 'Hide uploads' : 'Show uploads'}
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
          <ChevronDown className={cx('h-4 w-4 transition-transform', open && 'rotate-180')} />
        </button>
        {!active.length && (
          <button type="button" onClick={dismissFinished} aria-label="Dismiss" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {active.length > 0 && (
        <div className="flex items-center gap-2 px-3 pb-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-voice transition-all" style={{ width: `${progress}%` }} />
          </div>
          <span className="w-9 text-right text-xs tabular-nums text-slate-500">{progress}%</span>
          {active.some(canCancel) && (
            <button type="button" onClick={() => cancel()} className="rounded-md px-1.5 py-0.5 text-xs font-medium text-rose-600 hover:bg-rose-50">
              {active.length > 1 ? 'Cancel all' : 'Cancel'}
            </button>
          )}
        </div>
      )}
      {open && (
        <ul className="max-h-60 divide-y divide-slate-100 overflow-y-auto border-t border-slate-100">
          {jobs.map(job => (
            <li key={job.id} className="flex items-start gap-2.5 px-3 py-2">
              <span className="mt-0.5"><StatusIcon job={job} /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-slate-800">{job.title || job.name}</p>
                <p className={cx('truncate text-xs', job.status === 'error' ? 'text-rose-700' : 'text-slate-500')}>
                  {job.status === 'error' ? job.error
                    : job.status === 'cancelled' ? 'Cancelled'
                    : job.status === 'waiting' ? job.error
                      : job.kind === 'file' ? `${formatBytes(job.size)}${job.status === 'uploading' ? ` · ${job.progress}%` : ''}${job.resumed && job.status !== 'done' ? ' · resumed' : ''}`
                        : 'Link'}
                </p>
              </div>
              {canCancel(job) && (
                <button type="button" onClick={() => cancel([job.id])} aria-label={`Cancel upload of ${job.title || job.name}`} title="Cancel upload"
                  className="-mr-1 shrink-0 rounded-md p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600">
                  <X className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
