import React, { useMemo, useState } from 'react';
import { Ban, KeyRound, RotateCcw, Search, ShieldCheck, ShieldMinus, ShieldPlus, UserCheck, Users } from 'lucide-react';
import { api } from '../api.js';
import { fold } from '../fold.js';
import {
  Avatar, Badge, Button, EmptyState, ErrorBanner, Modal, PageHeader, ROLE_META, Spinner, cx, timeAgo, useAsync, useToast,
} from '../components/ui.jsx';

const FILTERS = [
  ['all', 'All'],
  ['admins', 'Admins'],
  ['user', 'Members'],
  ['suspended', 'Suspended'],
];

function GoogleDot() {
  return <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-white text-[10px] font-bold text-sky-600 ring-1 ring-slate-200">G</span>;
}

export default function Members({ user }) {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api('/users'), []);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);

  const all = data?.users || [];
  const counts = useMemo(() => ({
    all: all.length,
    admins: all.filter(m => m.role !== 'user').length,
    user: all.filter(m => m.role === 'user').length,
    suspended: all.filter(m => m.suspended).length,
  }), [all]);

  const members = useMemo(() => {
    const q = fold(query.trim());
    return all.filter(m => {
      if (filter === 'admins' && m.role === 'user') return false;
      if (filter === 'user' && m.role !== 'user') return false;
      if (filter === 'suspended' && !m.suspended) return false;
      return !q || [m.name, m.email].some(v => fold(v).includes(q));
    });
  }, [all, filter, query]);

  const canSuspend = member => member.id !== user.id && member.role !== 'site_admin';
  const canChangeRole = member => member.role !== 'site_admin';

  async function confirm() {
    const { member, action } = pending;
    setBusy(true);
    try {
      if (action === 'role') {
        const role = member.role === 'org_admin' ? 'user' : 'org_admin';
        await api(`/users/${member.id}`, { method: 'PATCH', body: { role } });
        toast(role === 'org_admin' ? `${member.name} is now an org admin.` : `${member.name} is now a member.`);
      } else {
        await api(`/users/${member.id}/suspend`, { method: 'POST', body: { suspended: !member.suspended } });
        toast(member.suspended ? `${member.name} has been reactivated.` : `${member.name} has been suspended.`);
      }
      setPending(null);
      await reload();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const statusBadge = member => (member.suspended
    ? <Badge tone="bg-rose-50 text-rose-700 ring-rose-600/20" icon={Ban}>Suspended</Badge>
    : <Badge tone="bg-emerald-50 text-emerald-700 ring-emerald-600/20" icon={UserCheck}>Active</Badge>);

  const actions = member => (
    <>
      {canChangeRole(member) && !member.suspended && (
        <Button variant="ghost" size="sm" icon={member.role === 'org_admin' ? ShieldMinus : ShieldPlus}
          onClick={() => setPending({ member, action: 'role' })}>
          {member.role === 'org_admin' ? 'Remove admin' : 'Make org admin'}
        </Button>
      )}
      {canSuspend(member) && (
        <Button variant="ghost" size="sm" icon={member.suspended ? RotateCcw : Ban}
          className={member.suspended ? '' : '!text-rose-600 hover:bg-rose-50 hover:!text-rose-700'}
          onClick={() => setPending({ member, action: 'suspend' })}>
          {member.suspended ? 'Reactivate' : 'Suspend'}
        </Button>
      )}
    </>
  );

  const identity = member => (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={member.name} />
      <div className="min-w-0">
        <p className={cx('truncate font-medium', member.suspended ? 'text-slate-500' : 'text-slate-900')}>
          {member.name}{member.id === user.id && <span className="ml-1.5 text-xs font-normal text-slate-400">(you)</span>}
        </p>
        <p className="truncate text-xs text-slate-500">{member.email}</p>
      </div>
    </div>
  );

  const dialog = pending && (() => {
    const { member, action } = pending;
    if (action === 'role') {
      return member.role === 'org_admin'
        ? { title: 'Remove org admin role?', body: member.name, cta: 'Remove role', variant: 'danger' }
        : { title: 'Make org admin?', body: member.name, cta: 'Make org admin', variant: 'primary' };
    }
    return member.suspended
      ? { title: 'Reactivate account?', body: member.name, cta: 'Reactivate', variant: 'primary' }
      : { title: 'Suspend account?', body: member.name, cta: 'Suspend', variant: 'danger' };
  })();

  return (
    <div>
      <PageHeader title="Members" />

      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}

      {data && (
        <>
          <div className="mb-6 grid grid-cols-3 gap-2 sm:gap-4">
            {[
              [Users, 'Total members', 'Members', counts.all, 'bg-sky-50 text-sky-600'],
              [ShieldCheck, 'Administrators', 'Admins', counts.admins, 'bg-brand-50 text-brand-600'],
              [Ban, 'Suspended', 'Suspended', counts.suspended, 'bg-rose-50 text-rose-600'],
            ].map(([Icon, label, short, value, tone]) => (
              <div key={label} className="card flex flex-col items-start gap-2 p-3 sm:flex-row sm:items-center sm:gap-4 sm:p-5">
                <div className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg sm:h-10 sm:w-10', tone)}><Icon className="h-4 w-4 sm:h-5 sm:w-5" /></div>
                <div className="min-w-0">
                  <p className="text-xl font-semibold text-slate-900 sm:text-2xl">{value}</p>
                  <p className="truncate text-xs text-slate-500 sm:text-sm"><span className="sm:hidden">{short}</span><span className="hidden sm:inline">{label}</span></p>
                </div>
              </div>
            ))}
          </div>

          <section className="card overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 sm:flex lg:self-start">
                {FILTERS.map(([id, label]) => (
                  <button key={id} type="button" onClick={() => setFilter(id)}
                    className={cx('whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition',
                      filter === id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900')}>
                    {label} <span className="ml-1 text-xs text-slate-400">{counts[id]}</span>
                  </button>
                ))}
              </div>
              <div className="relative lg:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input className="input pl-9" placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} />
              </div>
            </div>

            {!members.length ? <div className="p-6"><EmptyState icon={Users} title="No members found" /></div> : (
              <>
              <ul className="divide-y divide-slate-100 lg:hidden">
                {members.map(member => (
                  <li key={member.id} className={cx('px-4 py-3', member.suspended && 'bg-slate-50/40')}>
                    {identity(member)}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-12">
                      <Badge tone={ROLE_META[member.role].tone}>{ROLE_META[member.role].label}</Badge>
                      {statusBadge(member)}
                      <span className="text-xs text-slate-500">{member.uploads} {member.uploads === 1 ? 'upload' : 'uploads'} · Joined {timeAgo(member.createdAt)}</span>
                    </div>
                    {(canChangeRole(member) || canSuspend(member)) && (
                      <div className="mt-2 flex flex-wrap gap-1 pl-10">{actions(member)}</div>
                    )}
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto lg:block">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-5 py-3">Member</th>
                      <th className="px-5 py-3">Role</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="hidden px-5 py-3 xl:table-cell">Sign-in</th>
                      <th className="px-5 py-3">Uploads</th>
                      <th className="hidden px-5 py-3 xl:table-cell">Joined</th>
                      <th className="px-5 py-3"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {members.map(member => (
                      <tr key={member.id} className={cx('hover:bg-slate-50/60', member.suspended && 'bg-slate-50/40')}>
                        <td className="max-w-[16rem] px-5 py-3">{identity(member)}</td>
                        <td className="px-5 py-3"><Badge tone={ROLE_META[member.role].tone}>{ROLE_META[member.role].label}</Badge></td>
                        <td className="px-5 py-3">{statusBadge(member)}</td>
                        <td className="hidden px-5 py-3 xl:table-cell">
                          <div className="flex items-center gap-1.5 text-xs text-slate-600">
                            {member.google && <span className="inline-flex items-center gap-1"><GoogleDot /> Google</span>}
                            {member.google && member.password && <span className="text-slate-300">·</span>}
                            {member.password && <span className="inline-flex items-center gap-1"><KeyRound className="h-3.5 w-3.5 text-slate-400" /> Email</span>}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-slate-600">{member.uploads}</td>
                        <td className="hidden px-5 py-3 text-slate-500 xl:table-cell">{timeAgo(member.createdAt)}</td>
                        <td className="whitespace-nowrap px-5 py-3 text-right">
                          <div className="flex justify-end gap-1">{actions(member)}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </section>
        </>
      )}

      <Modal open={Boolean(pending)} onClose={() => !busy && setPending(null)} title={dialog?.title}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setPending(null)} disabled={busy}>Cancel</Button>
            <Button variant={dialog?.variant} loading={busy} onClick={confirm}>{dialog?.cta}</Button>
          </>
        )}>
        <p className="text-sm text-slate-600">{dialog?.body}</p>
      </Modal>
    </div>
  );
}
