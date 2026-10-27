import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Bell, Bookmark, ChevronDown, ClipboardCheck, CloudDownload, CloudOff, Download, FileClock, FolderOpen, HardDrive, History, LogOut, Menu, MessageSquarePlus, Monitor,
  Moon, PieChart, Plus, RefreshCw, Share, Sun, Trophy, UploadCloud, Users,
} from 'lucide-react';
import { api } from './api.js';
import { useNotifications } from './notifications.js';
import { listDownloads } from './offline.js';
import { useTheme } from './theme.js';
import { promptInstall, useInstallState } from './pwa.js';
import {
  cancelAll as cancelUploads, getJobs as getUploadJobs, isActive as isUploadActive, resumeSaved, subscribe as subscribeUploads,
} from './uploads.js';
import { APP_ORG, Avatar, Badge, Button, Logo, MadeWithLove, Modal, ROLE_META, SplashLoader, ToastProvider, cx, useToast } from './components/ui.jsx';
import { PersistentMediaPlayer, useMediaPlayer } from './components/MediaPlayer.jsx';
import UploadTray from './components/UploadTray.jsx';
import Activity from './views/Activity.jsx';
import Downloads from './views/Downloads.jsx';
import Notifications from './views/Notifications.jsx';
import Requests from './views/Requests.jsx';
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
  notifications: { label: 'Notifications', short: 'Alerts', icon: Bell, badge: 'unread', tone: 'bg-rose-500/15 text-rose-300', soft: 'bg-rose-50 text-rose-600' },
  overview: { label: 'Overview', icon: PieChart, roles: ['site_admin', 'org_admin'], tone: 'bg-teal-500/15 text-teal-300', soft: 'bg-teal-50 text-teal-600' },
  upload: { label: 'Contribute', icon: UploadCloud, tone: 'bg-pink-500/15 text-pink-300', soft: 'bg-pink-50 text-pink-600' },
  mine: { label: 'My submissions', short: 'Mine', icon: FileClock, tone: 'bg-sky-500/15 text-sky-300', soft: 'bg-sky-50 text-sky-600' },
  saved: { label: 'Saved', icon: Bookmark, tone: 'bg-amber-500/15 text-amber-300', soft: 'bg-amber-50 text-amber-600' },
  requests: { label: 'Requests', icon: MessageSquarePlus, tone: 'bg-fuchsia-500/15 text-fuchsia-300', soft: 'bg-fuchsia-50 text-fuchsia-600' },
  downloads: { label: 'Downloads', icon: CloudDownload, tone: 'bg-lime-500/15 text-lime-300', soft: 'bg-lime-50 text-lime-600' },
  leaderboard: { label: 'Leaderboard', short: 'Top 10', icon: Trophy, tone: 'bg-yellow-500/15 text-yellow-300', soft: 'bg-yellow-50 text-yellow-600' },
  review: { label: 'Review queue', short: 'Review', icon: ClipboardCheck, roles: ['site_admin', 'org_admin'], badge: 'pending', tone: 'bg-orange-500/15 text-orange-300', soft: 'bg-orange-50 text-orange-600' },
  members: { label: 'Members', icon: Users, roles: ['site_admin'], tone: 'bg-emerald-500/15 text-emerald-300', soft: 'bg-emerald-50 text-emerald-600' },
  storage: { label: 'Storage', icon: HardDrive, roles: ['site_admin'], tone: 'bg-cyan-500/15 text-cyan-300', soft: 'bg-cyan-50 text-cyan-600' },
  activity: { label: 'Activity log', short: 'Activity', icon: History, roles: ['site_admin'], tone: 'bg-indigo-500/15 text-indigo-300', soft: 'bg-indigo-50 text-indigo-600' },
};
const SECTIONS = [
  ['Content', ['library', 'notifications', 'overview', 'upload', 'mine', 'saved', 'requests', 'downloads', 'leaderboard']],
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

const THEME_OPTIONS = [['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'System', Monitor]];

function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1" role="radiogroup" aria-label="Theme">
      {THEME_OPTIONS.map(([value, label, Icon]) => (
        <button key={value} type="button" role="radio" aria-checked={theme === value} onClick={() => setTheme(value)}
          className={cx('flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition',
            theme === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}>
          <Icon className="h-3.5 w-3.5" />{label}
        </button>
      ))}
    </div>
  );
}

function SidebarThemeButton() {
  const [theme, setTheme] = useTheme();
  const index = THEME_OPTIONS.findIndex(([value]) => value === theme);
  const [, label, Icon] = THEME_OPTIONS[index];
  const next = THEME_OPTIONS[(index + 1) % THEME_OPTIONS.length];
  return (
    <button type="button" onClick={() => setTheme(next[0])} title={`Theme: ${label}. Switch to ${next[1]}`} aria-label={`Theme: ${label}. Switch to ${next[1]}`}
      className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 text-white/80 ring-1 ring-inset ring-white/15 transition hover:bg-white/20 hover:text-white">
      <Icon className="h-4 w-4" />
    </button>
  );
}

function PointsPill({ points, onClick, light }) {
  return (
    <button type="button" onClick={onClick} title="Leaderboard" aria-label={`Leaderboard, ${points ?? 0} points`}
      className={cx('flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold transition active:scale-95',
        light ? 'bg-white/15 text-white ring-1 ring-white/30 hover:bg-white/25' : 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 hover:bg-amber-100')}>
      <Trophy className="h-3.5 w-3.5" />
      {points == null ? '–' : points.toLocaleString()}
    </button>
  );
}

function ProfileMenu({ user, points, onLeaderboard, onSignOut, light }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const role = ROLE_META[user.role];
  useEffect(() => {
    if (!open) return undefined;
    const onDown = event => { if (!ref.current?.contains(event.target)) setOpen(false); };
    const onKey = event => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const close = then => () => { setOpen(false); then(); };
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(value => !value)} aria-haspopup="menu" aria-expanded={open} aria-label="Account"
        className={cx('flex items-center gap-2.5 rounded-full transition active:scale-95',
          light ? 'ring-2 ring-white/40' : 'py-1 pl-1 pr-2.5 ring-1 ring-inset ring-slate-200 hover:bg-slate-50', open && !light && 'bg-slate-50')}>
        <Avatar name={user.name} size="sm" />
        {!light && (
          <>
            <span className="max-w-[10rem] text-left leading-tight">
              <span className="block truncate text-sm font-semibold text-slate-900">{user.name}</span>
              <span className="block truncate text-[11px] text-slate-500">{role.label}</span>
            </span>
            <ChevronDown className={cx('h-4 w-4 text-slate-400 transition', open && 'rotate-180')} />
          </>
        )}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-72 origin-top-right animate-fade-in overflow-hidden rounded-2xl bg-white text-slate-900 shadow-pop ring-1 ring-slate-200">
          <div className="flex items-center gap-3 px-4 py-4">
            <Avatar name={user.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-900">{user.name}</p>
              <p className="truncate text-xs text-slate-500">{user.email}</p>
              <Badge tone={role.tone} className="mt-1">{role.label}</Badge>
            </div>
          </div>
          <div className="space-y-3 border-t border-slate-200 px-4 py-3">
            <button type="button" role="menuitem" onClick={close(onLeaderboard)}
              className="flex w-full items-center justify-between rounded-xl px-2 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50">
              <span className="flex items-center gap-2"><Trophy className="h-4 w-4 text-amber-500" />Points</span>
              <span className="font-semibold">{points == null ? '–' : points.toLocaleString()}</span>
            </button>
            <ThemeSwitch />
          </div>
          <div className="border-t border-slate-200 p-2">
            <button type="button" role="menuitem" onClick={close(onSignOut)}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-rose-600 transition hover:bg-rose-50">
              <LogOut className="h-4 w-4" />Sign out
            </button>
          </div>
        </div>
      )}
    </div>
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
  const notifications = useNotifications(user.id);
  const counts = { pending, unread: notifications.unread };
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
  useEffect(() => { refreshPending(); }, [refreshPending, view, notifications.pendingReview]);
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
  const [requestTarget, setRequestTarget] = useState(null);
  useEffect(() => { if (active !== 'upload') setRequestTarget(null); }, [active]);
  const uploadFor = useCallback(request => { setAddTarget(null); setRequestTarget(request); navigate('upload'); }, [navigate]);
  const [focusId, setFocusId] = useState(sharedContentId);
  const openContent = useCallback(id => { setFocusId(id); navigate('library'); }, [navigate]);
  const clearFocus = useCallback(() => setFocusId(null), []);
  const props = { user, config, navigate, onChanged: refreshPending, onAddTo: addTo, sharedContentId: focusId, onSharedOpened: clearFocus };
  const page = {
    library: <Library key="library" scope="library" {...props} />,
    overview: <Overview {...props} />,
    saved: <Library key="saved" scope="saved" {...props} />,
    leaderboard: <Leaderboard {...props} />,
    mine: <Library key="mine" scope="mine" {...props} />,
    upload: <Upload key={addTarget?.id || 'new'} parent={addTarget} onClearParent={() => setAddTarget(null)}
      request={requestTarget} onClearRequest={() => setRequestTarget(null)} {...props} />,
    requests: <Requests {...props} onUploadFor={uploadFor} onOpenContent={openContent} />,
    notifications: <Notifications {...props} notifications={notifications} onOpenContent={openContent} />,
    downloads: <Downloads {...props} />,
    review: <Review {...props} />,
    members: <Members {...props} />,
    storage: <Storage {...props} />,
    activity: <Activity {...props} />,
  }[active];

  const primary = BOTTOM_NAV[user.role];
  const overflow = Object.keys(ITEMS).filter(id => !['upload', 'leaderboard', 'notifications'].includes(id) && !primary.includes(id) && allowed(id, user.role));
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
        <div className="relative flex w-72 items-center justify-between px-[22px] py-5">
          <Logo light textClassName={reveal} />
          <div className={reveal}><SidebarThemeButton /></div>
        </div>
        <nav className="relative w-72 flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-3 py-1 [scrollbar-color:rgba(255,255,255,.15)_transparent] [scrollbar-width:thin]">
          {SECTIONS.map(([section, ids]) => {
            const items = ids.filter(id => allowed(id, user.role));
            if (!items.length) return null;
            return (
              <div key={section}>
                <p className={cx('mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-white/40', reveal)}>{section}</p>
                <ul className="space-y-0.5">
                  {items.map(id => {
                    const item = ITEMS[id];
                    const on = active === id;
                    return (
                      <li key={id}>
                        <button type="button" onClick={() => navigate(id)} title={item.label}
                          className={cx('flex w-14 items-center gap-3 rounded-xl px-3.5 py-1 text-sm font-medium transition-[width,background-color,color] duration-200 group-hover/side:w-full group-focus-within/side:w-full',
                            on ? 'bg-white/10 text-white shadow-inner' : 'text-white/65 hover:bg-white/5 hover:text-white')}>
                          <span className={cx('relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition', on ? 'bg-voice text-white shadow-glow' : item.tone)}>
                            <item.icon className="h-4 w-4" />
                            {item.badge && <CountBadge value={counts[item.badge]} className="absolute -right-1.5 -top-1.5 group-hover/side:hidden group-focus-within/side:hidden" />}
                          </span>
                          <span className={cx('whitespace-nowrap', reveal)}>{item.label}</span>
                          {item.badge && <CountBadge value={counts[item.badge]} className={cx('ml-auto px-2 py-1 text-[11px]', reveal)} />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>
        <div className="relative w-72 space-y-1.5 px-3 pb-3 pt-2">
          {canInstall && (
            <button type="button" onClick={install} title="Install app"
              className="flex w-14 items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold text-white/80 ring-1 ring-inset ring-white/15 transition-[width,background-color] duration-200 hover:bg-white/10 hover:text-white group-hover/side:w-full group-focus-within/side:w-full">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white"><Download className="h-4 w-4" /></span>
              <span className={cx('whitespace-nowrap', reveal)}>Install app</span>
            </button>
          )}
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
          <button type="button" onClick={() => navigate('notifications')} aria-label={`Notifications${notifications.unread ? `, ${notifications.unread} unread` : ''}`}
            className={cx('relative flex h-9 w-9 items-center justify-center rounded-full transition active:scale-95', active === 'notifications' ? 'bg-white/25' : 'hover:bg-white/15')}>
            <Bell className="h-5 w-5" />
            <CountBadge value={notifications.unread} className="absolute -right-0.5 -top-0.5 ring-2 ring-voice" />
          </button>
          <ProfileMenu light user={user} points={points} onLeaderboard={() => navigate('leaderboard')} onSignOut={askSignOut} />
        </div>
      </header>

      <div className="overflow-x-clip lg:pl-20">
        <header className="sticky top-0 z-30 hidden border-b border-slate-200/70 bg-white/90 backdrop-blur lg:block">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-end gap-3 px-10">
            <PointsPill points={points} onClick={() => navigate('leaderboard')} />
            <button type="button" onClick={() => navigate('notifications')} title="Notifications"
              aria-label={`Notifications${notifications.unread ? `, ${notifications.unread} unread` : ''}`}
              className={cx('relative flex h-10 w-10 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-700',
                active === 'notifications' && 'bg-slate-100 text-slate-700')}>
              <Bell className="h-5 w-5" />
              <CountBadge value={notifications.unread} className="absolute right-0.5 top-0.5 ring-2 ring-white" />
            </button>
            <span className="h-6 w-px bg-slate-200" aria-hidden="true" />
            <ProfileMenu user={user} points={points} onLeaderboard={() => navigate('leaderboard')} onSignOut={askSignOut} />
          </div>
        </header>
        <main key={active} className="mx-auto max-w-7xl animate-fade-in px-4 pb-28 pt-5 sm:px-6 lg:px-10 lg:pb-12 lg:pt-8">{page}</main>
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
                  {item.badge && <CountBadge value={counts[item.badge]} className="absolute -right-0.5 -top-1" />}
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
              <ThemeSwitch />
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

// Without a connection, people can still play what they downloaded earlier.
function OfflineShell({ onRetry }) {
  return (
    <div className="min-h-screen">
      <PersistentMediaPlayer />
      <header className="pt-safe sticky top-0 z-30 bg-voice text-white shadow-md">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
          <Logo size="sm" light />
          <div className="flex-1" />
          <span className="flex items-center gap-1.5 text-xs font-medium text-white/80"><CloudOff className="h-4 w-4" />Offline</span>
          <Button size="sm" variant="secondary" icon={RefreshCw} onClick={onRetry}>Retry</Button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 pb-28 pt-5 sm:px-6">
        <Downloads />
      </main>
    </div>
  );
}

function Root() {
  const [state, setState] = useState({ loading: true, user: null, config: null, offline: false });
  const [hash, setHash] = useState(currentHash);
  const toast = useToast();

  useEffect(() => {
    const onHash = () => setHash(currentHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const load = useCallback(async () => {
    const config = await api('/config').catch(() => null);
    let offline = false;
    const user = await api('/auth/me').then(data => data.user).catch(error => {
      offline = error.status === 0;
      return null;
    });
    if (offline) offline = listDownloads().length > 0;
    setState({ loading: false, user, config, offline });
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
  if (!state.user && state.offline) return <OfflineShell onRetry={load} />;
  if (!state.user) return <Login config={state.config} onSignedIn={load} />;
  return <Shell user={state.user} config={state.config} onSignOut={signOut} />;
}

export default function App() {
  return <ToastProvider><Root /></ToastProvider>;
}
