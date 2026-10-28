import React, { useMemo, useState } from 'react';
import { CopyCheck, Eye, FileText, Link2, ListChecks, Trash2, X } from 'lucide-react';
import { api } from '../api.js';
import { ContentThumb, PreviewModal } from '../components/Content.jsx';
import { Badge, Button, EmptyState, ErrorBanner, PageHeader, STATUS_META, Spinner, cx, formatBytes, timeAgo, useAsync, useToast } from '../components/ui.jsx';
import { RemoveContentModal } from './Library.jsx';

const copies = count => `${count} ${count === 1 ? 'copy' : 'copies'}`;
const DUPLICATE_REASON = 'Duplicate of content that is already in the library.';

export default function Duplicates({ user, onChanged }) {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api('/duplicates'), []);
  const [preview, setPreview] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const groups = data?.groups || [];
  const extra = groups.reduce((sum, group) => sum + group.items.length - 1, 0);
  const byId = useMemo(() => new Map(groups.flatMap(group => group.items.map(item => [item.id, item]))), [groups]);
  const chosen = [...selected].filter(id => byId.has(id)).map(id => byId.get(id));
  const laterCopies = list => list.flatMap(group => group.items.slice(1).map(item => item.id));

  const toggle = id => setSelected(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const add = ids => setSelected(current => new Set([...current, ...ids]));

  function removed(result) {
    if (result) {
      const failed = result.failed || [];
      toast(failed.length ? `Removed ${result.removed}. ${failed.length} could not be removed: ${failed[0].error}` : `Removed ${result.removed} ${result.removed === 1 ? 'item' : 'items'}.`, failed.length ? 'error' : undefined);
      setSelected(new Set(failed.map(entry => entry.id)));
    } else {
      toast('Content removed.');
      setSelected(current => { const next = new Set(current); next.delete(removing?.id); return next; });
    }
    setRemoving(null);
    setPreview(null);
    reload();
    onChanged?.();
  }

  return (
    <div>
      <PageHeader title="Duplicates" />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          Uploads that contain the same file or link. Only site admins can see this page.
          {groups.length > 0 && <> <span className="font-medium text-slate-900">{groups.length} {groups.length === 1 ? 'group' : 'groups'}</span>, {copies(extra)} beyond the first upload.</>}
        </p>
        {extra > 0 && (
          <Button variant="secondary" size="sm" icon={ListChecks} onClick={() => setSelected(new Set(laterCopies(groups)))}>
            Select all extra copies
          </Button>
        )}
      </div>
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && !groups.length && <EmptyState icon={CopyCheck} title="No duplicates" description="Every file and link in the library is unique." />}
      <div className="space-y-4">
        {groups.map(group => (
          <section key={group.id} className="card overflow-hidden">
            <header className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 text-sm">
              {group.isLink ? <Link2 className="h-4 w-4 shrink-0 text-slate-400" /> : <FileText className="h-4 w-4 shrink-0 text-slate-400" />}
              <span className="font-semibold text-slate-900">Same {group.isLink ? 'link' : 'file'}</span>
              <span className="truncate text-slate-500">· {copies(group.items.length)}</span>
              <button type="button" onClick={() => add(laterCopies([group]))}
                className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium text-brand-600 hover:bg-brand-50">
                Select copies
              </button>
            </header>
            <ul className="divide-y divide-slate-100">
              {group.items.map((item, index) => {
                const on = selected.has(item.id);
                return (
                  <li key={item.id} className={cx('flex items-center gap-3 py-2.5 pl-3 pr-2 sm:pl-4 sm:pr-3', on && 'bg-rose-50/60')}>
                    <input type="checkbox" checked={on} onChange={() => toggle(item.id)} className="h-4 w-4 shrink-0 accent-brand-600"
                      aria-label={`Select ${item.title}`} />
                    <button type="button" onClick={() => setPreview(item)} className="shrink-0" aria-label={`Preview ${item.title}`}>
                      <ContentThumb item={item} className="h-10 w-16 rounded-md" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-900">{item.title}</p>
                      <p className="flex min-w-0 items-center gap-1.5 text-xs text-slate-500">
                        {index === 0 && <Badge tone="bg-emerald-50 text-emerald-700 ring-emerald-600/20" className="shrink-0 px-1.5 py-0 text-[10px]">First upload</Badge>}
                        {item.status !== 'approved' && <Badge tone={STATUS_META[item.status].tone} className="shrink-0 px-1.5 py-0 text-[10px]">{STATUS_META[item.status].label}</Badge>}
                        <span className="truncate">
                          {item.uploader} · {timeAgo(item.created_at)}{item.type !== 'link' ? ` · ${formatBytes(item.size)}` : ''}
                          {item.parent_title ? ` · inside “${item.parent_title}”` : ''}
                        </span>
                      </p>
                    </div>
                    <button type="button" onClick={() => setPreview(item)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800" aria-label={`Open ${item.title}`}>
                      <Eye className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => setRemoving(item)} className="rounded-lg p-2 text-rose-600 hover:bg-rose-50" aria-label={`Remove ${item.title}`}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      {chosen.length > 0 && (
        <div className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-20 mt-4 lg:bottom-4">
          <div className="mx-auto flex max-w-xl items-center gap-2 rounded-2xl bg-slate-900 px-3 py-2.5 text-white shadow-pop ring-1 ring-white/10 animate-fade-in">
            <button type="button" onClick={() => setSelected(new Set())} aria-label="Clear selection"
              className="rounded-full p-1.5 text-slate-300 hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{chosen.length} selected</span>
            <Button variant="danger" size="sm" icon={Trash2} onClick={() => setRemoving({ many: chosen })}>Remove {chosen.length}</Button>
          </div>
        </div>
      )}
      <PreviewModal item={preview} onClose={() => setPreview(null)} user={user} />
      <RemoveContentModal item={removing?.many ? null : removing} items={removing?.many} defaultReason={removing?.many ? DUPLICATE_REASON : ''}
        onClose={() => setRemoving(null)} onRemoved={removed} />
    </div>
  );
}