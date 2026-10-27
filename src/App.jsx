import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  Bookmark, ClipboardCheck, Download, FileClock, FolderOpen, HardDrive, History, LogOut, Menu, PieChart, Plus, Share, Trophy, UploadCloud, Users,
} from 'lucide-react';
import { api } from './api.js';
import { promptInstall, useInstallState } from './pwa.js';
import {
  cancelAll as cancelUploads, getJobs as getUploadJobs, isActive as isUploadActive, resumeSaved, subscribe as subscribeUploads,
} from './uploads.js';
import { APP_ORG, Avatar, Badge, Button, Logo, MadeWithLove, Modal, ROLE_META, SplashLoader, ToastProvider, cx, useToast } from './components/ui.jsx';
import { PersistentMediaPlayer, useMediaPlayer } from './components/MediaPlayer.jsx';
import UploadTray from './components/UploadTray.jsx';
import Activity from './views/Activity.jsx';
import Library from './views/Library.jsx';
import Leaderboard from './views/Leaderboard.jsx';
import Legal, { LEGAL_PAGES } from './views/Legal.jsx';
import Login from './views/Login.jsx';
import Members from './views/Members.jsx';
import Overview from './views/Overview.jsx';
import Review from './views/Review.jsx';
import Storage from './views/Storage.jsx';
import Upload from './views/Upload.jsx';

const ITEMS = {
  library: { label: 'Library', icon: FolderOpen, tone: 'bg-violet-500/15 text-violet-300', soft: 'bg-violet-50 text-violet-600' },
  overview: { label: 'Overview', icon: PieChart, roles: ['site_admin', 'org_admin'], tone: 'bg-teal-500/15 text-teal-300', soft: 'bg-teal-50 text-teal-600' },
  upload: { label: 'Contribute', icon: UploadCloud, tone: 'bg-pink-500/15 text-pink-300', soft: 'bg-pink-50 text-pink-600' },
  mine: { label: 'My submissions', short: 'Mine', icon: FileClock, tone: 'bg-sky-500/15 text-sky-300', soft: 'bg-sky-50 text-sky-600' },
  saved: { label: 'Saved', icon: Bookmark, tone: 'bg-amber-500/15 text-amber-300', soft: 'bg-amber-50 text-amber-600' },
  leaderboard: { label: 'Leaderboard', short: 'Top 10', icon: Trophy, tone: 'bg-yellow-500/15 text-yellow-300', soft: 'bg-yellow-50 text-yellow-600' },
  review: { label: 'Review queue', short: 'Review', icon: ClipboardCheck, roles: ['site_admin', 'org_admin'], badge: true, tone: 'bg-orange-500/15 text-orange-300', soft: 'bg-orange-50 text-orange-600' },
  members: { label: 'Members', icon: Users, roles: ['site_admin'], tone: 'bg-emerald-500/15 text-emerald-300', soft: 'bg-emerald-50 text-emerald-600' },
  storage: { label: 'Storage', icon: HardDrive, roles: ['site_admin'], tone: 'bg-cyan-500/15 text-cyan-300', soft: 'bg-cyan-50 text-cyan-600' },
  activity: { label: 'Activity log', short: 'Activity', icon: History, roles: ['site_admin'], tone: 'bg-indigo-500/15 text-indigo-300', soft: 'bg-indigo-50 text-indigo-600' },
};
const SECTIONS = [
  ['Content', ['library', 'overview', 'upload', 'mine', 'saved', 'leaderboard']],
  ['Administration', ['review', 'members', 'storage', 'activity']],
];
const BOTTOM_NAV = {
  site_admin: ['library', 'review', 'members'],
  org_admin: ['library', 'review', 'mine'],
  user: ['library', 'saved', 'mine'],
};

const allowed = (id, role) => !ITEMS[id].roles || ITEMS[id].roles.includes(role);
const reveal = 'opacity-0 transition-opacity duration-200 group-hover/side:opacity-100 group-focus-within/side:opacity-100';
const currentHash = () => window.location.hash.replace(/^#\/?/, '') || 'library';
const VERSION_LABEL = `Version ${__APP_VERSION__}`;

function CountBadge({ value, className }) {
  if (!value) return null;
  return <span className={cx('rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white', className)}>{value > 99 ? '99+' : value}</span>;
}

function PointsPill({ points, onClick, light }) {
  return (
    <button type="button" onClick={onClick} title="Leaderboard" aria-label={`Leaderboard, ${points ?? 0} points`}
      className={cx('flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold transition active:scale-95',
        light ? 'bg-white/15 text-white ring-1 ring-white/30 hover:bg-white/25' : 'bg-amber-400/15 text-amber-300 ring-1 ring-amber-300/30 hover:bg-amber-400/25')}>
      <Trophy className="h-3.5 w-3.5" />
      {points == null ? '–' : points.toLocaleString()}
    </button>
  );
}

function Shell({ user, config, onSignOut }) {
  const toast = useToast();
  const [view, setView] = useState(currentHash);
  const [sharedContentId] = useState(() => new URLSearchParams(window.location.search).get('content'));
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pending, setPending] = useState(0);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const installState = useInstallState();
  const [iosHelp, setIosHelp] = useState(false);
  async function install() {
    setSheetOpen(false);
    if (installState === 'ios') { setIosHelp(true); return; }
    if (await promptInstall()) toast('Kalpa Taru is being installed.');
  }
  const canInstall = installState === 'prompt' || installState === 'ios';
  const askSignOut = () => { setSheetOpen(false); setConfirmSignOut(true); };
  const closeSignOut = useCallback(() => setConfirmSignOut(false), []);
  async function doSignOut() {
    setSigningOut(true);
    try { await onSignOut(); } finally { setSigningOut(false); }
  }
  const isReviewer = allowed('review', user.role);
  const { closePlayer } = useMediaPlayer();
  useEffect(() => () => closePlayer(), [closePlayer]);
  const uploadJobs = useSyncExternalStore(subscribeUploads, getUploadJobs);
  const uploading = uploadJobs.filter(isUploadActive).length;

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
    resumeSaved(user.id, job => { if (job?.status === 'done') refreshPending(); })
      .then(count => { if (count) toast(`Resuming ${count === 1 ? '1 unfinished upload' : `${count} unfinished uploads`}.`); });
  }, [user.id, refreshPending, toast]);
  const [points, setPoints] = useState(null);
  useEffect(() => { api('/leaderboard').then(data => setPoints(data.me.points)).catch(() => {}); }, [view]);

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
  const [addTarget, setAddTarget] = useState(null);
  useEffect(() => { if (active !== 'upload') setAddTarget(null); }, [active]);
  const addTo = useCallback(item => { setAddTarget({ id: item.id, title: item.title }); navigate('upload'); }, [navigate]);
  const props = { user, config, navigate, onChanged: refreshPending, onAddTo: addTo, sharedContentId };
  const page = {
    library: <Library key="library" scope="library" {...props} />,
    overview: <Overview {...props} />,
    saved: <Library key="saved" scope="saved" {...props} />,
    leaderboard: <Leaderboard {...props} />,
    mine: <Library key="mine" scope="mine" {...props} />,
    upload: <Upload key={addTarget?.id || 'new'} parent={addTarget} onClearParent={() => setAddTarget(null)} {...props} />,
    review: <Review {...props} />,
    members: <Members {...props} />,
    storage: <Storage {...props} />,
    activity: <Activity {...props} />,
  }[active];

  const primary = BOTTOM_NAV[user.role];
  const overflow = Object.keys(ITEMS).filter(id => !['upload', 'leaderboard'].includes(id) && !primary.includes(id) && allowed(id, user.role));
  const role = ROLE_META[user.role];

  return (
    <div className="min-h-screen">
      <PersistentMediaPlayer />
      {/* Desktop sidebar: an icon rail that expands over the page on hover or keyboard focus */}
      <aside onMouseLeave={event => { if (event.currentTarget.contains(document.activeElement)) document.activeElement.blur(); }}
        className="group/side fixed inset-y-0 left-0 z-40 hidden w-20 overflow-hidden bg-slate-950 text-white transition-[width,box-shadow] duration-200 ease-out hover:w-72 hover:shadow-2xl focus-within:w-72 focus-within:shadow-2xl lg:flex lg:flex-col">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-indigo-950 via-slate-950 to-slate-950" />
        <div className="pointer-events-none absolute -left-24 -top-24 h-64 w-64 rounded-full bg-violet-600/30 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -right-24 h-72 w-72 rounded-full bg-pink-600/20 blur-3xl" />
        <div className="relative w-72 px-[22px] py-6"><Logo light textClassName={reveal} /></div>
        <nav className="relative w-72 flex-1 space-y-7 overflow-y-auto overflow-x-hidden px-3 py-2">
          {SECTIONS.map(([section, ids]) => {
            const items = ids.filter(id => allowed(id, user.role));
            if (!items.length) return null;
            return (
              <div key={section}>
                <p className={cx('mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-white/40', reveal)}>{section}</p>
                <ul className="space-y-1">
                  {items.map(id => {
                    const item = ITEMS[id];
                    const on = active === id;
                    return (
                      <li key={id}>
                        <button type="button" onClick={() => navigate(id)} title={item.label}
                          className={cx('flex w-14 items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-[width,background-color,color] duration-200 group-hover/side:w-full group-focus-within/side:w-full',
                            on ? 'bg-white/10 text-white shadow-inner' : 'text-white/65 hover:bg-white/5 hover:text-white')}>
                          <span className={cx('relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition', on ? 'bg-voice text-white shadow-glow' : item.tone)}>
                            <item.icon className="h-4 w-4" />
                            {item.badge && <CountBadge value={pending} className="absolute -right-1.5 -top-1.5 group-hover/side:hidden group-focus-within/side:hidden" />}
                          </span>
                          <span className={cx('whitespace-nowrap', reveal)}>{item.label}</span>
                          {item.badge && <CountBadge value={pending} className={cx('ml-auto px-2 py-1 text-[11px]', reveal)} />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>
        <div className="relative m-3 w-14 overflow-hidden rounded-2xl bg-white/5 p-[10px] ring-1 ring-white/10 transition-[width] duration-200 group-hover/side:w-[264px] group-focus-within/side:w-[264px]">
          <div className="flex w-[244px] items-center gap-3">
            <Avatar name={user.name} />
            <div className={cx('min-w-0 flex-1', reveal)}>
              <p className="truncate text-sm font-semibold">{user.name}</p>
              <p className="truncate text-xs text-white/50">{role.label}</p>
            </div>
            <div className={cx('flex items-center gap-1', reveal)}>
              <PointsPill points={points} onClick={() => navigate('leaderboard')} />
            </div>
          </div>
        </div>
        <div className="relative w-72 space-y-1.5 px-3 pb-3">
          {canInstall && (
            <button type="button" onClick={install} title="Install app"
              className="flex w-14 items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold text-white/80 ring-1 ring-inset ring-white/15 transition-[width,background-color] duration-200 hover:bg-white/10 hover:text-white group-hover/side:w-full group-focus-within/side:w-full">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white"><Download className="h-4 w-4" /></span>
              <span className={cx('whitespace-nowrap', reveal)}>Install app</span>
            </button>
          )}
          <button type="button" onClick={askSignOut} title="Sign out"
            className="flex w-14 items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold text-rose-200 ring-1 ring-inset ring-rose-400/30 transition-[width,background-color] duration-200 hover:bg-rose-500/15 hover:text-white group-hover/side:w-full group-focus-within/side:w-full">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rose-500/20 text-rose-300"><LogOut className="h-4 w-4" /></span>
            <span className={cx('whitespace-nowrap', reveal)}>Sign out</span>
          </button>
        </div>
        <div className="relative mb-3 w-20 space-y-1 text-center text-[10px] text-white/40 transition-[width] duration-200 group-hover/side:w-72 group-focus-within/side:w-72">
          <p className="flex items-center justify-center gap-1 whitespace-nowrap">
            <span className="hidden group-hover/side:inline group-focus-within/side:inline">Made with</span>
            <span className="text-rose-400" role="img" aria-label="love">❤</span>
            <span className="hidden group-hover/side:inline group-focus-within/side:inline">by {APP_ORG}</span>
          </p>
          <p className="flex justify-center gap-1.5">
            <a href="#/privacy" className="transition hover:text-white">Privacy</a>·<a href="#/terms" className="transition hover:text-white">Terms</a>
          </p>
          <p className="whitespace-nowrap">{VERSION_LABEL}</p>
        </div>
      </aside>
      {/* Mobile top app bar */}
      <header className="pt-safe sticky top-0 z-30 bg-voice text-white shadow-md lg:hidden">
        <div className="flex h-14 items-center gap-3 px-4">
          <Logo size="sm" light />
          <div className="flex-1" />
          <PointsPill light points={points} onClick={() => navigate('leaderboard')} />
          <button type="button" onClick={() => setSheetOpen(true)} className="rounded-full ring-2 ring-white/40 transition active:scale-95" aria-label="Account and menu">
            <Avatar name={user.name} size="sm" />
          </button>
        </div>
      </header>

      <div className="overflow-x-clip lg:pl-20">
        <main key={active} className="mx-auto max-w-7xl animate-fade-in px-4 pb-28 pt-5 sm:px-6 lg:px-10 lg:pb-12 lg:pt-10">{page}</main>
      </div>
      {active !== 'upload' && <UploadTray />}

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
            <div className="space-y-2 border-t border-slate-100 p-4">
              {canInstall && <Button variant="secondary" icon={Download} onClick={install} className="w-full justify-center">Install app</Button>}
              <Button variant="danger" icon={LogOut} onClick={askSignOut} className="w-full justify-center">Sign out</Button>
              <MadeWithLove className="pt-4 text-xs text-slate-500" />
              <p className="flex justify-center gap-2 px-3 pt-1.5 text-[11px] text-slate-400">
                <a href="#/privacy" className="font-medium text-slate-500 hover:text-brand-700">Privacy Policy</a>·
                <a href="#/terms" className="font-medium text-slate-500 hover:text-brand-700">Terms & Conditions</a>·
                <span>{VERSION_LABEL}</span>
              </p>
            </div>
          </div>
        </div>
      )}

      <Modal open={iosHelp} onClose={() => setIosHelp(false)} size="sm" title="Install Kalpa Taru"
        footer={<Button onClick={() => setIosHelp(false)}>Got it</Button>}>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-600">
          <li>Tap the <Share className="inline h-4 w-4 align-text-bottom text-brand-600" /> <span className="font-medium">Share</span> button in Safari.</li>
          <li>Choose <span className="font-medium">Add to Home Screen</span>.</li>
          <li>Tap <span className="font-medium">Add</span>. Kalpa Taru opens like an app from your home screen.</li>
        </ol>
      </Modal>

      <Modal open={confirmSignOut} onClose={closeSignOut} size="sm" title="Sign out?"
        footer={(
          <>
            <Button variant="secondary" onClick={closeSignOut} disabled={signingOut}>Cancel</Button>
            <Button variant="danger" icon={LogOut} loading={signingOut} onClick={doSignOut}>Sign out</Button>
          </>
        )}>
        <p className="text-sm text-slate-600">{user.email}</p>
        {uploading > 0 && (
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-amber-200">
            {uploading === 1 ? '1 upload is' : `${uploading} uploads are`} still in progress and will be cancelled.
          </p>
        )}
      </Modal>
    </div>
  );
}

function Root() {
  const [state, setState] = useState({ loading: true, user: null, config: null });
  const [hash, setHash] = useState(currentHash);
  const toast = useToast();

  useEffect(() => {
    const onHash = () => setHash(currentHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

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
    await cancelUploads();
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setState(current => ({ ...current, user: null }));
    window.history.replaceState(null, '', '/');
  }

  if (LEGAL_PAGES.includes(hash)) return <Legal page={hash} signedIn={Boolean(state.user)} />;
  if (state.loading) return <SplashLoader />;
  if (!state.user) return <Login config={state.config} onSignedIn={load} />;
  return <Shell user={state.user} config={state.config} onSignOut={signOut} />;
}

export default function App() {
  return <ToastProvider><Root /></ToastProvider>;
}
