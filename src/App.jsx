import React, { useCallback, useEffect, useState } from 'react';
import {
  Bookmark, ClipboardCheck, FileClock, FolderOpen, HardDrive, History, LogOut, Menu, Plus, UploadCloud, Users,
} from 'lucide-react';
import { api } from './api.js';
import { Avatar, Badge, Button, Logo, Modal, ROLE_META, Spinner, ToastProvider, cx, useToast } from './components/ui.jsx';
import { PersistentMediaPlayer, useMediaPlayer } from './components/MediaPlayer.jsx';
import Activity from './views/Activity.jsx';
import Library from './views/Library.jsx';
import Login from './views/Login.jsx';
import Members from './views/Members.jsx';
import Review from './views/Review.jsx';
import Storage from './views/Storage.jsx';
import Upload from './views/Upload.jsx';

const ITEMS = {
  library: { label: 'Library', icon: FolderOpen, tone: 'bg-violet-500/15 text-violet-300', soft: 'bg-violet-50 text-violet-600' },
  upload: { label: 'Contribute', icon: UploadCloud, tone: 'bg-pink-500/15 text-pink-300', soft: 'bg-pink-50 text-pink-600' },
  mine: { label: 'My submissions', short: 'Mine', icon: FileClock, tone: 'bg-sky-500/15 text-sky-300', soft: 'bg-sky-50 text-sky-600' },
  saved: { label: 'Saved', icon: Bookmark, tone: 'bg-amber-500/15 text-amber-300', soft: 'bg-amber-50 text-amber-600' },
  review: { label: 'Review queue', short: 'Review', icon: ClipboardCheck, roles: ['site_admin', 'org_admin'], badge: true, tone: 'bg-orange-500/15 text-orange-300', soft: 'bg-orange-50 text-orange-600' },
  members: { label: 'Members', icon: Users, roles: ['site_admin'], tone: 'bg-emerald-500/15 text-emerald-300', soft: 'bg-emerald-50 text-emerald-600' },
  storage: { label: 'Storage', icon: HardDrive, roles: ['site_admin'], tone: 'bg-cyan-500/15 text-cyan-300', soft: 'bg-cyan-50 text-cyan-600' },
  activity: { label: 'Activity log', short: 'Activity', icon: History, roles: ['site_admin'], tone: 'bg-indigo-500/15 text-indigo-300', soft: 'bg-indigo-50 text-indigo-600' },
};
const SECTIONS = [
  ['Content', ['library', 'upload', 'mine', 'saved']],
  ['Administration', ['review', 'members', 'storage', 'activity']],
];
const BOTTOM_NAV = {
  site_admin: ['library', 'review', 'members'],
  org_admin: ['library', 'review', 'mine'],
  user: ['library', 'saved', 'mine'],
};

const allowed = (id, role) => !ITEMS[id].roles || ITEMS[id].roles.includes(role);
const currentHash = () => window.location.hash.replace(/^#\/?/, '') || 'library';

function CountBadge({ value, className }) {
  if (!value) return null;
  return <span className={cx('rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white', className)}>{value > 99 ? '99+' : value}</span>;
}

function Shell({ user, config, onSignOut }) {
  const toast = useToast();
  const [view, setView] = useState(currentHash);
  const [sharedContentId] = useState(() => new URLSearchParams(window.location.search).get('content'));
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pending, setPending] = useState(0);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const askSignOut = () => { setSheetOpen(false); setConfirmSignOut(true); };
  const closeSignOut = useCallback(() => setConfirmSignOut(false), []);
  async function doSignOut() {
    setSigningOut(true);
    try { await onSignOut(); } finally { setSigningOut(false); }
  }
  const isReviewer = allowed('review', user.role);
  const { closePlayer } = useMediaPlayer();
  useEffect(() => () => closePlayer(), [closePlayer]);

  const navigate = useCallback(id => { window.location.hash = `/${id}`; setSheetOpen(false); window.scrollTo(0, 0); }, []);
  useEffect(() => {
    const onHash = () => setView(currentHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refreshPending = useCallback(() => {
    if (isReviewer) api('/overview').then(data => setPending(data.pending)).catch(() => {});
  }, [isReviewer]);
  useEffect(() => { refreshPending(); }, [refreshPending, view]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected')) { toast('Google Drive connected successfully.'); navigate('storage'); }
    if (params.get('authError')) toast(params.get('authError'), 'error');
    if (params.toString()) window.history.replaceState(null, '', `/${window.location.hash}`);
  }, [toast, navigate]);

  useEffect(() => {
    if (!sheetOpen) return undefined;
    const onKey = event => event.key === 'Escape' && setSheetOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheetOpen]);

  const active = ITEMS[view] && allowed(view, user.role) ? view : 'library';
  const props = { user, config, navigate, onChanged: refreshPending, sharedContentId };
  const page = {
    library: <Library key="library" scope="library" {...props} />,
    saved: <Library key="saved" scope="saved" {...props} />,
    mine: <Library key="mine" scope="mine" {...props} />,
    upload: <Upload {...props} />,
    review: <Review {...props} />,
    members: <Members {...props} />,
    storage: <Storage {...props} />,
    activity: <Activity {...props} />,
  }[active];

  const primary = BOTTOM_NAV[user.role];
  const overflow = Object.keys(ITEMS).filter(id => id !== 'upload' && !primary.includes(id) && allowed(id, user.role));
  const role = ROLE_META[user.role];

  return (
    <div className="min-h-screen">
      <PersistentMediaPlayer />
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 overflow-hidden bg-slate-950 text-white lg:flex lg:flex-col">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-indigo-950 via-slate-950 to-slate-950" />
        <div className="pointer-events-none absolute -left-24 -top-24 h-64 w-64 rounded-full bg-violet-600/30 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -right-24 h-72 w-72 rounded-full bg-pink-600/20 blur-3xl" />
        <div className="relative px-6 py-6"><Logo light /></div>
        <nav className="relative flex-1 space-y-7 overflow-y-auto px-4 py-2">
          {SECTIONS.map(([section, ids]) => {
            const items = ids.filter(id => allowed(id, user.role));
            if (!items.length) return null;
            return (
              <div key={section}>
                <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-white/40">{section}</p>
                <ul className="space-y-1">
                  {items.map(id => {
                    const item = ITEMS[id];
                    const on = active === id;
                    return (
                      <li key={id}>
                        <button type="button" onClick={() => navigate(id)}
                          className={cx('group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-sm font-medium transition',
                            on ? 'bg-white/10 text-white shadow-inner' : 'text-white/65 hover:bg-white/5 hover:text-white')}>
                          <span className={cx('flex h-8 w-8 items-center justify-center rounded-lg transition', on ? 'bg-voice text-white shadow-glow' : item.tone)}>
                            <item.icon className="h-4 w-4" />
                          </span>
                          {item.label}
                          {item.badge && <CountBadge value={pending} className="ml-auto px-2 py-1 text-[11px]" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>
        <div className="relative m-4 rounded-2xl bg-white/5 p-3 ring-1 ring-white/10">
          <div className="flex items-center gap-3">
            <Avatar name={user.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{user.name}</p>
              <p className="truncate text-xs text-white/50">{role.label}</p>
            </div>
            <button type="button" onClick={askSignOut} className="rounded-lg p-2 text-white/60 transition hover:bg-white/10 hover:text-white" aria-label="Sign out" title="Sign out">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile top app bar */}
      <header className="pt-safe sticky top-0 z-30 bg-voice text-white shadow-md lg:hidden">
        <div className="flex h-14 items-center gap-3 px-4">
          <Logo size="sm" light tagline={false} />
          <span className="h-5 w-px bg-white/30" />
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{ITEMS[active].short || ITEMS[active].label}</h1>
          <button type="button" onClick={() => setSheetOpen(true)} className="rounded-full ring-2 ring-white/40 transition active:scale-95" aria-label="Account and menu">
            <Avatar name={user.name} size="sm" />
          </button>
        </div>
      </header>

      <div className="lg:pl-72">
        <main key={active} className="mx-auto max-w-7xl animate-fade-in px-4 pb-28 pt-5 sm:px-6 lg:px-10 lg:pb-12 lg:pt-10">{page}</main>
      </div>

      {/* Mobile bottom navigation */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-slate-200/70 bg-white/95 shadow-nav backdrop-blur lg:hidden" aria-label="Primary">
        <div className="grid h-16 grid-cols-5">
          {[primary[0], primary[1], 'fab', primary[2], 'more'].map(id => {
            if (id === 'fab') {
              return (
                <div key="fab" className="flex justify-center">
                  <button type="button" onClick={() => navigate('upload')} aria-label="Contribute"
                    className={cx('-mt-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-voice text-white shadow-glow ring-4 ring-white transition active:scale-95',
                      active === 'upload' && 'ring-brand-100')}>
                    <Plus className="h-7 w-7" strokeWidth={2.5} />
                  </button>
                </div>
              );
            }
            const isMore = id === 'more';
            const item = isMore ? { label: 'More', icon: Menu } : ITEMS[id];
            const on = isMore ? overflow.includes(active) || sheetOpen : active === id;
            return (
              <button key={id} type="button" onClick={() => (isMore ? setSheetOpen(true) : navigate(id))}
                className="flex flex-col items-center justify-center gap-1">
                <span className={cx('relative flex h-8 w-14 items-center justify-center rounded-full transition', on ? 'bg-brand-100 text-brand-700' : 'text-slate-500')}>
                  <item.icon className="h-5 w-5" strokeWidth={on ? 2.4 : 2} />
                  {item.badge && <CountBadge value={pending} className="absolute -right-0.5 -top-1" />}
                </span>
                <span className={cx('text-[11px] font-medium', on ? 'text-brand-700' : 'text-slate-500')}>{item.short || item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Mobile "More" bottom sheet */}
      {sheetOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setSheetOpen(false)} />
          <div className="pb-safe absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-3xl bg-white shadow-pop animate-sheet-up">
            <div className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-slate-300" />
            <div className="flex items-center gap-4 px-5 pb-4 pt-4">
              <Avatar name={user.name} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold text-slate-900">{user.name}</p>
                <p className="truncate text-sm text-slate-500">{user.email}</p>
                <Badge tone={role.tone} className="mt-1.5">{role.label}</Badge>
              </div>
            </div>
            {overflow.length > 0 && (
              <div className="grid grid-cols-3 gap-2 border-t border-slate-100 px-4 py-4">
                {overflow.map(id => {
                  const item = ITEMS[id];
                  return (
                    <button key={id} type="button" onClick={() => navigate(id)}
                      className={cx('flex flex-col items-center gap-2 rounded-2xl px-2 py-3 text-xs font-medium transition active:scale-95',
                        active === id ? 'bg-brand-50 text-brand-700' : 'text-slate-700 hover:bg-slate-50')}>
                      <span className={cx('flex h-11 w-11 items-center justify-center rounded-2xl', item.soft)}><item.icon className="h-5 w-5" /></span>
                      {item.label}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="border-t border-slate-100 p-3">
              <button type="button" onClick={askSignOut} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium text-rose-600 hover:bg-rose-50">
                <LogOut className="h-5 w-5" /> Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      <Modal open={confirmSignOut} onClose={closeSignOut} size="sm" title="Sign out?"
        footer={(
          <>
            <Button variant="secondary" onClick={closeSignOut} disabled={signingOut}>Cancel</Button>
            <Button variant="danger" icon={LogOut} loading={signingOut} onClick={doSignOut}>Sign out</Button>
          </>
        )}>
        <p className="text-sm text-slate-600">You are signed in as <span className="font-medium text-slate-900">{user.email}</span>. You will need to sign in again to use VOICE.</p>
      </Modal>
    </div>
  );
}

function Root() {
  const [state, setState] = useState({ loading: true, user: null, config: null });
  const toast = useToast();

  const load = useCallback(async () => {
    const config = await api('/config').catch(() => null);
    const user = await api('/auth/me').then(data => data.user).catch(() => null);
    setState({ loading: false, user, config });
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!state.loading && !state.user && params.get('authError')) {
      toast(params.get('authError'), 'error');
      window.history.replaceState(null, '', '/');
    }
  }, [state.loading, state.user, toast]);

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setState(current => ({ ...current, user: null }));
    window.history.replaceState(null, '', '/');
  }

  if (state.loading) return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>;
  if (!state.user) return <Login config={state.config} onSignedIn={load} />;
  return <Shell user={state.user} config={state.config} onSignOut={signOut} />;
}

export default function App() {
  return <ToastProvider><Root /></ToastProvider>;
}
