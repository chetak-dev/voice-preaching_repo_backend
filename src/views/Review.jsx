import React, { useState } from 'react';
import { Check, Eye, Inbox, X } from 'lucide-react';
import { api } from '../api.js';
import { ContentThumb, PreviewModal } from '../components/Content.jsx';
import {
  Avatar, Badge, Button, EmptyState, ErrorBanner, Modal, PageHeader, Spinner, TYPE_META, formatBytes, timeAgo, useAsync, useToast,
} from '../components/ui.jsx';

export default function Review({ user, onChanged }) {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api('/content?scope=review'), []);
  const [preview, setPreview] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);

  async function decide(item, decision, reviewNote = '') {
    setBusy(item.id);
    try {
      await api(`/content/${item.id}/review`, { method: 'POST', body: { decision, note: reviewNote } });
      toast(decision === 'approved' ? `Published "${item.title}".` : `Rejected "${item.title}".`);
      setRejecting(null); setPreview(null); setNote('');
      await reload();
      onChanged?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(null); }
  }

  const items = data?.items || [];
  const isOwn = item => user.role === 'org_admin' && item.uploader_id === user.id;
  return (
    <div>
      <PageHeader title="Review queue"
        description="Every contribution must be approved here before it is published. Org admins cannot approve their own submissions." />
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && !items.length && <EmptyState icon={Inbox} title="You're all caught up" description="New submissions will appear here for approval." />}
      {items.length > 0 && (
        <div className="space-y-3">
          {items.map(item => {
            const meta = TYPE_META[item.type];
            return (
              <div key={item.id} className="card flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
                <button type="button" onClick={() => setPreview(item)} className="h-32 w-full shrink-0 overflow-hidden rounded-xl sm:h-20 sm:w-32" aria-label={`Preview ${item.title}`}>
                  <ContentThumb item={item} className="h-full w-full" />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-slate-900">{item.title}</h3>
                    <Badge tone={meta.tone} icon={meta.icon}>{meta.label}</Badge>
                    {item.type !== 'link' && <span className="text-xs text-slate-400">{formatBytes(item.size)}</span>}
                  </div>
                  {item.description && <p className="mt-1 line-clamp-2 text-sm text-slate-500">{item.description}</p>}
                  {item.type === 'link' && <p className="mt-1 truncate text-xs text-sky-700">{item.url}</p>}
                  <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                    <Avatar name={item.uploader} size="sm" />
                    <span>{item.uploader} · {timeAgo(item.created_at)}</span>
                  </div>
                </div>
                {isOwn(item) ? (
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" icon={Eye} onClick={() => setPreview(item)}>Preview</Button>
                    <Badge tone="bg-slate-100 text-slate-600 ring-slate-500/20">Your submission</Badge>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-col lg:flex-row">
                    <Button variant="secondary" size="sm" icon={Eye} onClick={() => setPreview(item)}>Preview</Button>
                    <Button variant="secondary" size="sm" icon={X} onClick={() => { setRejecting(item); setNote(''); }} className="text-rose-600">Reject</Button>
                    <Button variant="success" size="sm" icon={Check} loading={busy === item.id} onClick={() => decide(item, 'approved')}>Approve</Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <PreviewModal item={preview} onClose={() => setPreview(null)}
        actions={preview && !isOwn(preview) && (
          <>
            <Button variant="secondary" icon={X} className="text-rose-600" onClick={() => { setRejecting(preview); setPreview(null); }}>Reject</Button>
            <Button variant="success" icon={Check} loading={busy === preview.id} onClick={() => decide(preview, 'approved')}>Approve</Button>
          </>
        )} />

      <Modal open={Boolean(rejecting)} onClose={() => setRejecting(null)} size="sm" title="Reject submission"
        description="The contributor will see this note under My submissions."
        footer={(
          <>
            <Button variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button>
            <Button variant="danger" disabled={note.trim().length < 5} loading={busy === rejecting?.id} onClick={() => decide(rejecting, 'rejected', note)}>Reject</Button>
          </>
        )}>
        <label className="label" htmlFor="note">Reason</label>
        <textarea id="note" rows={4} className="input" maxLength={1000} autoFocus value={note} onChange={e => setNote(e.target.value)}
          placeholder="e.g. Please add a description and credit the original speaker." />
        <p className="mt-1.5 text-xs text-slate-500">At least 5 characters.</p>
      </Modal>
    </div>
  );
}
