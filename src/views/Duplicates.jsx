import React, { useState } from 'react';
import { CopyCheck, Eye, FileText, Link2, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { ContentThumb, PreviewModal } from '../components/Content.jsx';
import { Badge, EmptyState, ErrorBanner, PageHeader, STATUS_META, Spinner, cx, formatBytes, timeAgo, useAsync, useToast } from '../components/ui.jsx';
import { RemoveContentModal } from './Library.jsx';

const copies = count => `${count} ${count === 1 ? 'copy' : 'copies'}`;

export default function Duplicates({ user, onChanged }) {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api('/duplicates'), []);
  const [preview, setPreview] = useState(null);
  const [removing, setRemoving] = useState(null);
  const groups = data?.groups || [];
  const extra = groups.reduce((sum, group) => sum + group.items.length - 1, 0);

  function removed() {
    toast('Content removed.');
    setRemoving(null);
    setPreview(null);
    reload();
    onChanged?.();
  }

  return (
    <div>
      <PageHeader title="Duplicates" />
      <p className="mb-4 text-sm text-slate-600">
        Uploads that contain the same file or link. Only site admins can see this page.
        {groups.length > 0 && <> <span className="font-medium text-slate-900">{groups.length} {groups.length === 1 ? 'group' : 'groups'}</span>, {copies(extra)} beyond the first upload.</>}
      </p>
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && !groups.length && <EmptyState icon={CopyCheck} title="No duplicates" description="Every file and link in the library is unique." />}
      <div className="space-y-4">
        {groups.map(group => (
          <section key={group.id} className="card overflow-hidden">
            <header className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 text-sm">
              {group.isLink ? <Link2 className="h-4 w-4 text-slate-400" /> : <FileText className="h-4 w-4 text-slate-400" />}
              <span className="font-semibold text-slate-900">Same {group.isLink ? 'link' : 'file'}</span>
              <span className="text-slate-500">· {copies(group.items.length)}</span>
            </header>
            <ul className="divide-y divide-slate-100">
              {group.items.map((item, index) => (
                <li key={item.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
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
                  <button type="button" onClick={() => setRemoving(item)} className={cx('rounded-lg p-2 text-rose-600 hover:bg-rose-50')} aria-label={`Remove ${item.title}`}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <PreviewModal item={preview} onClose={() => setPreview(null)} user={user} />
      <RemoveContentModal item={removing} onClose={() => setRemoving(null)} onRemoved={removed} />
    </div>
  );
}
