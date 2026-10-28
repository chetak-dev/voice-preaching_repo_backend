import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Eye, Inbox, Search, X } from 'lucide-react';
import { api } from '../api.js';
import { fold } from '../fold.js';
import { ContentThumb, PreviewModal } from '../components/Content.jsx';
import {
  Avatar, Badge, Button, EmptyState, ErrorBanner, Modal, PageHeader, Spinner, TYPE_META, formatBytes, timeAgo, useAsync, useToast,
} from '../components/ui.jsx';

const MAX_BULK_REVIEW = 25;
const WHERE = { approved: 'already in the library', pending: 'also waiting for review' };

function DuplicateNote({ match, onView }) {
  return (
    <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 ring-1 ring-amber-200">
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        Possible duplicate: the same {match.isLink ? 'link' : 'file'} is {WHERE[match.status] || 'already uploaded'} as{' '}
        <button type="button" onClick={onView} className="font-semibold underline underline-offset-2 hover:text-amber-900">“{match.title}”</button>.
      </span>
    </p>
  );
}

export default function Review({ user, onChanged }) {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api('/content?scope=review'), []);
  const [preview, setPreview] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState([]);
  const [dupConfirm, setDupConfirm] = useState(null);

  async function viewExisting(match) {
    try { setPreview((await api(`/content/${match.id}`)).item); } catch (err) { toast(err.message, 'error'); }
  }
  // Approving something that looks like a duplicate needs a second, deliberate click.
  function approve(item) {
    if (item.duplicateOf) { setPreview(null); setDupConfirm({ items: [item] }); } else decide(item, 'approved');
  }
  function approveBulk() {
    const dups = items.filter(item => selected.includes(item.id) && item.duplicateOf);
    if (dups.length) setDupConfirm({ bulk: true, items: dups }); else approveSelected();
  }
  async function confirmDuplicate() {
    const { bulk, items: dups } = dupConfirm;
    setDupConfirm(null);
    if (bulk) await approveSelected(); else await decide(dups[0], 'approved');
  }

  async function decide(item, decision, reviewNote = '') {
    setBusy(item.id);
    try {
      await api(`/content/${item.id}/review`, { method: 'POST', body: { decision, note: reviewNote } });
      toast(decision === 'approved' ? `Published "${item.title}".` : `Rejected "${item.title}".`);
      setRejecting(null); setPreview(null); setNote('');
      setSelected(current => current.filter(id => id !== item.id));
      await reload();
      onChanged?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(null); }
  }

  async function approveSelected() {
    if (!selected.length || busy) return;
    setBusy('bulk');
    try {
      const result = await api('/review/bulk-approve', { method: 'POST', body: { ids: selected } });
      setSelected([]);
      toast(`Approved ${result.approved}; skipped ${result.skipped} changed or ineligible submission${result.skipped === 1 ? '' : 's'}.`);
      await reload();
      onChanged?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(null); }
  }

  async function rejectSelected(reason) {
    if (!selected.length || busy) return;
    setBusy('bulk-reject');
    try {
      const result = await api('/review/bulk-reject', { method: 'POST', body: { ids: selected, note: reason } });
      setSelected([]); setRejecting(null); setNote('');
      toast(`Rejected ${result.rejected}${result.skipped ? `; skipped ${result.skipped} changed or ineligible submission${result.skipped === 1 ? '' : 's'}` : ''}.`);
      await reload();
      onChanged?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(null); }
  }

  const items = data?.items || [];
  const isOwn = item => user.role === 'org_admin' && item.uploader_id === user.id;
  const reviewable = useMemo(() => items.filter(item => !isOwn(item)), [items, user.id, user.role]);
  const filtered = useMemo(() => {
    const term = fold(query.trim());
    return reviewable.filter(item => !term || [item.title, item.description, item.uploader].some(value => fold(value).includes(term)));
  }, [reviewable, query]);
  const selectIds = filtered.slice(0, MAX_BULK_REVIEW).map(item => item.id);
  const allFilteredSelected = selectIds.length > 0 && selectIds.every(id => selected.includes(id));

  function toggleAll() {
    if (allFilteredSelected) setSelected(current => current.filter(id => !selectIds.includes(id)));
    else setSelected(current => [...new Set([...current, ...selectIds])].slice(0, MAX_BULK_REVIEW));
  }
  function toggleOne(id) {
    setSelected(current => current.includes(id) ? current.filter(value => value !== id)
      : current.length >= MAX_BULK_REVIEW ? current : [...current, id]);
  }

  return (
    <div>
      <PageHeader title="Review queue" />
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && !items.length && <EmptyState icon={Inbox} title="You're all caught up" />}
      {items.length > 0 && (
        <div className="card mb-5 space-y-3 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input className="input pl-9" value={query} onChange={event => setQuery(event.target.value)}
                placeholder="Search" aria-label="Search review queue" />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <Button variant="secondary" icon={X} className="text-rose-600" disabled={!selected.length || Boolean(busy)}
                onClick={() => { setRejecting({ bulk: true }); setNote(''); }}>
                Reject {selected.length || ''}
              </Button>
              <Button variant="success" icon={Check} loading={busy === 'bulk'} disabled={!selected.length || Boolean(busy)} onClick={approveBulk}>
                Approve {selected.length || ''}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
            <span>{items.length} pending · {reviewable.length} eligible · showing {filtered.length}</span>
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={allFilteredSelected} onChange={toggleAll} disabled={!selectIds.length || Boolean(busy)} />
              Select first {Math.min(filtered.length, MAX_BULK_REVIEW)} eligible
            </label>
          </div>
        </div>
      )}
      {items.length > 0 && !filtered.length && <EmptyState icon={Search} title="No matching submissions" />}
      {items.length > 0 && filtered.length > 0 && (
        <div className="space-y-3">
          {filtered.map(item => {
            const meta = TYPE_META[item.type];
            const own = isOwn(item);
            return (
              <div key={item.id} className="card flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
                {!own && <input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggleOne(item.id)}
                  aria-label={`Select ${item.title}`} disabled={Boolean(busy) || (!selected.includes(item.id) && selected.length >= MAX_BULK_REVIEW)} />}
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
                  {item.parent_title && <p className="mt-1 truncate text-xs font-medium text-brand-700">Adding to: {item.parent_title}</p>}
                  {item.type === 'link' && <p className="mt-1 truncate text-xs text-sky-700">{item.url}</p>}
                  {item.duplicateOf && <DuplicateNote match={{ ...item.duplicateOf, isLink: item.type === 'link' }} onView={() => viewExisting(item.duplicateOf)} />}
                  <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                    <Avatar name={item.uploader} size="sm" />
                    <span>{item.uploader} · {timeAgo(item.created_at)}</span>
                  </div>
                </div>
                {own ? (
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" icon={Eye} onClick={() => setPreview(item)}>Preview</Button>
                    <Badge tone="bg-slate-100 text-slate-600 ring-slate-500/20">Your submission</Badge>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-col lg:flex-row">
                    <Button variant="secondary" size="sm" icon={Eye} onClick={() => setPreview(item)}>Preview</Button>
                    <Button variant="secondary" size="sm" icon={X} onClick={() => { setRejecting(item); setNote(''); }} className="text-rose-600">Reject</Button>
                    <Button variant="success" size="sm" icon={Check} loading={busy === item.id} disabled={Boolean(busy)} onClick={() => approve(item)}>Approve</Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <PreviewModal item={preview} onClose={() => setPreview(null)} user={user}
        onEdited={(item, changes) => { setPreview(current => (current?.id === item.id ? { ...current, ...changes } : current)); toast('Details updated.'); reload(); }}
        actions={preview && preview.status === 'pending' && !isOwn(preview) && (
          <>
            <Button variant="secondary" icon={X} className="text-rose-600" onClick={() => { setRejecting(preview); setPreview(null); }}>Reject</Button>
            <Button variant="success" icon={Check} loading={busy === preview.id} onClick={() => approve(items.find(item => item.id === preview.id) || preview)}>Approve</Button>
          </>
        )} />

      <Modal open={Boolean(dupConfirm)} onClose={() => setDupConfirm(null)} size="sm"
        title={dupConfirm?.bulk ? 'Some selected items look like duplicates' : 'This looks like a duplicate'}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setDupConfirm(null)}>Go back</Button>
            <Button variant="success" className="whitespace-nowrap" onClick={confirmDuplicate}>
              {dupConfirm?.bulk ? `Approve all ${selected.length}` : 'Approve anyway'}
            </Button>
          </>
        )}>
        <p className="mb-3 text-sm text-slate-600">
          The same file or link is already in Kalpa Taru. Approve only if this is a different version; otherwise reject it.
        </p>
        <ul className="space-y-2">
          {dupConfirm?.items.map(item => (
            <li key={item.id} className="rounded-lg bg-amber-50 px-3 py-2 text-sm ring-1 ring-amber-200">
              <p className="truncate font-medium text-slate-900">{item.title}</p>
              <p className="text-xs text-amber-800">Matches “{item.duplicateOf.title}” · {WHERE[item.duplicateOf.status] || 'already uploaded'}</p>
            </li>
          ))}
        </ul>
      </Modal>

      <Modal open={Boolean(rejecting)} onClose={() => setRejecting(null)} size="sm"
        title={rejecting?.bulk ? `Reject ${selected.length} submission${selected.length === 1 ? '' : 's'}` : 'Reject submission'}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button>
            <Button variant="danger" disabled={note.trim().length < 5} loading={rejecting?.bulk ? busy === 'bulk-reject' : busy === rejecting?.id}
              onClick={() => (rejecting?.bulk ? rejectSelected(note) : decide(rejecting, 'rejected', note))}>Reject</Button>
          </>
        )}>
        {rejecting?.bulk && <p className="mb-3 text-sm text-slate-600">Every contributor will see this reason.</p>}
        <label className="label" htmlFor="note">Reason</label>
        <textarea id="note" rows={4} className="input" maxLength={1000} autoFocus value={note} onChange={event => setNote(event.target.value)} />
      </Modal>
    </div>
  );
}
