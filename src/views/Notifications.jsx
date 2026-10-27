import React from 'react';
import { Bell, CheckCheck, CheckCircle2, ChevronRight, ClipboardCheck, MessageSquarePlus, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { Button, EmptyState, PageHeader, cx, timeAgo } from '../components/ui.jsx';

const KINDS = {
  approved: { icon: CheckCircle2, tone: 'bg-emerald-50 text-emerald-600' },
  rejected: { icon: XCircle, tone: 'bg-rose-50 text-rose-600' },
  removed: { icon: Trash2, tone: 'bg-slate-100 text-slate-500' },
  request: { icon: MessageSquarePlus, tone: 'bg-violet-50 text-violet-600' },
  role: { icon: ShieldCheck, tone: 'bg-amber-50 text-amber-600' },
};

export default function Notifications({ navigate, notifications, onOpenContent }) {
  const { items, unread, pendingReview, markRead } = notifications;

  function open(item) {
    if (!item.read_at) markRead([item.id]);
    if (item.kind === 'rejected') navigate('mine');
    else if (item.kind === 'request' && !item.content_id) navigate('requests');
    else if (item.content_id && item.kind !== 'removed') onOpenContent(item.content_id);
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Notifications" actions={unread > 0 && <Button variant="secondary" size="sm" icon={CheckCheck} onClick={() => markRead()}>Mark all read</Button>} />

      {pendingReview > 0 && (
        <button type="button" onClick={() => navigate('review')}
          className="mb-4 flex w-full items-center gap-3 rounded-2xl bg-orange-50 p-4 text-left ring-1 ring-orange-200 transition hover:bg-orange-100">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-100 text-orange-600"><ClipboardCheck className="h-5 w-5" /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-orange-900">{pendingReview === 1 ? '1 item is' : `${pendingReview} items are`} waiting for review</span>
            <span className="block text-xs text-orange-800/80">Approve or reject them in the review queue.</span>
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-orange-400" />
        </button>
      )}

      {items.length === 0 ? (
        <EmptyState icon={Bell} title="You’re all caught up" description="You’ll be notified here when your contributions are reviewed or your requests are fulfilled." />
      ) : (
        <ul className="card divide-y divide-slate-100 overflow-hidden">
          {items.map(item => {
            const kind = KINDS[item.kind] || { icon: Bell, tone: 'bg-brand-50 text-brand-600' };
            const unreadItem = !item.read_at;
            return (
              <li key={item.id}>
                <button type="button" onClick={() => open(item)}
                  className={cx('flex w-full items-start gap-3 px-4 py-3.5 text-left transition hover:bg-slate-50', unreadItem && 'bg-brand-50/40')}>
                  <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', kind.tone)}><kind.icon className="h-4 w-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className={cx('block text-sm', unreadItem ? 'font-semibold text-slate-900' : 'font-medium text-slate-700')}>{item.title}</span>
                    {item.body && <span className="mt-0.5 block text-sm text-slate-500">{item.body}</span>}
                    <span className="mt-1 block text-xs text-slate-400">{timeAgo(item.created_at)}</span>
                  </span>
                  {unreadItem && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-600" aria-label="Unread" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
