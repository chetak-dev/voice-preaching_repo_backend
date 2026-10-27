import React, { useState } from 'react';
import { CheckCircle2, ChevronUp, ExternalLink, MessageSquarePlus, Plus, UploadCloud, X } from 'lucide-react';
import { api } from '../api.js';
import { LANGUAGES } from '../components/Tags.jsx';
import { Avatar, Badge, Button, EmptyState, ErrorBanner, Modal, PageHeader, Spinner, cx, timeAgo, useAsync, useToast } from '../components/ui.jsx';

const TABS = [['open', 'Open'], ['fulfilled', 'Fulfilled'], ['closed', 'Closed']];
const EMPTY = { title: '', details: '', language: '' };

function NewRequestModal({ open, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  const close = () => { if (!busy) { setForm(EMPTY); setError(''); onClose(); } };

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/requests', { method: 'POST', body: { ...form, title: form.title.trim(), details: form.details.trim() } });
      toast('Request posted. Others can upvote it.');
      setForm(EMPTY);
      onCreated();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={close} title="Request content" description="Ask for a class, kirtan or document you couldn’t find. Contributors will see it."
      footer={(
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
          <Button type="submit" form="new-request" loading={busy} disabled={form.title.trim().length < 5}>Post request</Button>
        </>
      )}>
      <form id="new-request" onSubmit={submit} className="space-y-3">
        <div>
          <label className="label" htmlFor="request-title">What are you looking for?</label>
          <input id="request-title" className="input" required minLength={5} maxLength={160} autoFocus value={form.title} onChange={set('title')}
            placeholder="e.g. Bhagavad Gita 2.13 class in Odia" />
        </div>
        <div>
          <label className="label" htmlFor="request-details">Details <span className="font-normal text-slate-400">(optional)</span></label>
          <textarea id="request-details" rows={3} maxLength={1000} className="input resize-y" value={form.details} onChange={set('details')}
            placeholder="Speaker, occasion, audience or anything else that helps." />
        </div>
        <div>
          <label className="label" htmlFor="request-language">Language <span className="font-normal text-slate-400">(optional)</span></label>
          <select id="request-language" className="input" value={form.language} onChange={set('language')}>
            <option value="">Any language</option>
            {LANGUAGES.map(language => <option key={language} value={language}>{language}</option>)}
          </select>
        </div>
        {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      </form>
    </Modal>
  );
}

function RequestCard({ item, tab, isReviewer, onVote, onUpload, onClose, onOpen }) {
  const open = tab === 'open';
  return (
    <li className="card flex gap-3 p-4 sm:gap-4">
      <button type="button" onClick={() => open && onVote(item)} disabled={!open} aria-pressed={item.voted}
        aria-label={`${item.voted ? 'Remove vote' : 'Upvote'}, ${item.votes} votes`}
        className={cx('flex h-14 w-12 shrink-0 flex-col items-center justify-center rounded-xl text-sm font-semibold ring-1 transition',
          item.voted ? 'bg-brand-50 text-brand-700 ring-brand-200' : 'text-slate-600 ring-slate-200',
          open ? 'hover:ring-brand-300 active:scale-95' : 'cursor-default opacity-70')}>
        <ChevronUp className="h-4 w-4" strokeWidth={2.5} />
        <span className="tabular-nums">{item.votes}</span>
      </button>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-slate-900">{item.title}</p>
        {item.details && <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{item.details}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          <span className="flex items-center gap-1.5"><Avatar name={item.requester} size="xs" />{item.mine ? 'You' : item.requester}</span>
          <span>{timeAgo(item.created_at)}</span>
          {item.language && <Badge tone="bg-slate-50 text-slate-600 ring-slate-200">{item.language}</Badge>}
        </div>
        {tab === 'fulfilled' && item.content_id && (
          <button type="button" onClick={() => onOpen(item.content_id)}
            className="mt-3 inline-flex max-w-full items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 hover:bg-emerald-100">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{item.content_title || 'View content'}</span>
            <ExternalLink className="h-3 w-3 shrink-0" />
          </button>
        )}
        {open && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon={UploadCloud} onClick={() => onUpload(item)}>Upload for this</Button>
            {(item.mine || isReviewer) && <Button size="sm" variant="ghost" icon={X} onClick={() => onClose(item)}>Close</Button>}
          </div>
        )}
      </div>
    </li>
  );
}

export default function Requests({ user, navigate, onUploadFor, onOpenContent }) {
  const toast = useToast();
  const [tab, setTab] = useState('open');
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data, loading, error, reload } = useAsync(() => api(`/requests?status=${tab}`), [tab]);
  const [overrides, setOverrides] = useState({});
  const isReviewer = ['site_admin', 'org_admin'].includes(user.role);
  const items = (data?.items || []).map(item => ({ ...item, ...overrides[item.id] }));

  async function vote(item) {
    setOverrides(current => ({ ...current, [item.id]: { voted: !item.voted, votes: item.votes + (item.voted ? -1 : 1) } }));
    try {
      const result = await api(`/requests/${encodeURIComponent(item.id)}/vote`, { method: 'POST' });
      setOverrides(current => ({ ...current, [item.id]: result }));
    } catch (err) {
      setOverrides(current => ({ ...current, [item.id]: { voted: item.voted, votes: item.votes } }));
      toast(err.message, 'error');
    }
  }

  async function confirmClose() {
    setBusy(true);
    try {
      await api(`/requests/${encodeURIComponent(closing.id)}/close`, { method: 'POST' });
      toast('Request closed.');
      setClosing(null);
      reload();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Requests" actions={<Button icon={Plus} onClick={() => setCreating(true)}>New request</Button>} />
      <p className="-mt-2 mb-4 text-sm text-slate-500">Can’t find something? Ask for it here. Upvote requests you need too, and contributors can upload for them.</p>

      <div className="mb-4 flex gap-1 rounded-xl bg-slate-100 p-1" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => { setTab(key); setOverrides({}); }}
            className={cx('flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition',
              tab === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}>
            {label}
          </button>
        ))}
      </div>

      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && !data ? <Spinner /> : items.length === 0 ? (
        <EmptyState icon={MessageSquarePlus} title={tab === 'open' ? 'No open requests' : `No ${tab} requests yet`}
          description={tab === 'open' ? 'Be the first to ask for something you need.' : undefined}
          action={tab === 'open' && <Button icon={Plus} onClick={() => setCreating(true)}>New request</Button>} />
      ) : (
        <ul className={cx('space-y-3', loading && 'opacity-60')}>
          {items.map(item => (
            <RequestCard key={item.id} item={item} tab={tab} isReviewer={isReviewer} onVote={vote}
              onUpload={request => onUploadFor({ id: request.id, title: request.title, language: request.language })} onClose={setClosing}
              onOpen={id => (onOpenContent ? onOpenContent(id) : navigate('library'))} />
          ))}
        </ul>
      )}

      <NewRequestModal open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); if (tab === 'open') reload(); else setTab('open'); }} />
      <Modal open={Boolean(closing)} onClose={() => !busy && setClosing(null)} size="sm" title="Close this request?"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setClosing(null)} disabled={busy}>Cancel</Button>
            <Button variant="danger" loading={busy} onClick={confirmClose}>Close request</Button>
          </>
        )}>
        <p className="text-sm text-slate-600">“{closing?.title}” will move to Closed and can no longer be voted on.</p>
      </Modal>
    </div>
  );
}
