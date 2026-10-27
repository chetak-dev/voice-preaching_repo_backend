import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, FileText, Image as ImageIcon, Info, Link2, Loader2, Music, Video, X,
} from 'lucide-react';

export const TYPE_META = {
  image: { label: 'Image', plural: 'Images', icon: ImageIcon, tone: 'bg-sky-50 text-sky-700 ring-sky-600/20', tile: 'from-sky-400 to-blue-600 text-white' },
  video: { label: 'Video', plural: 'Videos', icon: Video, tone: 'bg-violet-50 text-violet-700 ring-violet-600/20', tile: 'from-violet-500 to-fuchsia-600 text-white' },
  audio: { label: 'Audio', plural: 'Audio', icon: Music, tone: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', tile: 'from-emerald-400 to-teal-600 text-white' },
  doc: { label: 'Document', plural: 'Documents', icon: FileText, tone: 'bg-amber-50 text-amber-700 ring-amber-600/20', tile: 'from-amber-400 to-orange-600 text-white' },
  link: { label: 'Link', plural: 'Links', icon: Link2, tone: 'bg-slate-100 text-slate-700 ring-slate-600/20', tile: 'from-indigo-500 to-cyan-500 text-white' },
};

export const ROLE_META = {
  site_admin: { label: 'Site admin', tone: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-600/20' },
  org_admin: { label: 'Org admin', tone: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20' },
  user: { label: 'Member', tone: 'bg-slate-100 text-slate-700 ring-slate-500/20' },
};

export const STATUS_META = {
  pending: { label: 'Pending review', tone: 'bg-amber-50 text-amber-800 ring-amber-600/20' },
  approved: { label: 'Approved', tone: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  rejected: { label: 'Rejected', tone: 'bg-rose-50 text-rose-700 ring-rose-600/20' },
};

export const cx = (...classes) => classes.filter(Boolean).join(' ');

// The Kalpa Taru mark: the wish-fulfilling tree, bearing golden fruit.
export function LogoMark({ className }) {
  const id = React.useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c3aed" /><stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="14" fill={`url(#${id}bg)`} />
      <path d="M15.5 40.6q8.5-3 17 0" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeOpacity=".6" />
      <path d="M21.4 40c1-3.8 1.3-7.8 1.3-12h2.6c0 4.2.3 8.2 1.3 12z" fill="#fff" />
      <g fill="#fff">
        <circle cx="24" cy="16.5" r="9" /><circle cx="15.8" cy="22.4" r="6.6" /><circle cx="32.2" cy="22.4" r="6.6" /><circle cx="24" cy="24.4" r="7.6" />
      </g>
      <path d="M24 31V17.5M24 27l-5-4.2M24 24l4.8-4" fill="none" stroke="#6d28d9" strokeWidth="1.7" strokeLinecap="round" />
      <g fill="#f59e0b"><circle cx="24" cy="15.6" r="2.3" /><circle cx="18.2" cy="22" r="2.3" /><circle cx="29.6" cy="19.2" r="2.3" /></g>
    </svg>
  );
}

export const APP_NAME = 'Kalpa Taru';
export const APP_ORG = 'ISKCON Brahmapur';

export function Logo({ size = 'md', light = false, textClassName }) {
  const box = size === 'lg' ? 'h-11 w-11 rounded-2xl' : size === 'sm' ? 'h-8 w-8 rounded-xl' : 'h-9 w-9 rounded-xl';
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark className={cx('shrink-0 shadow-glow', box, light && 'ring-2 ring-white/30')} />
      <div className={cx('flex flex-col justify-center gap-[5px] leading-none', textClassName)}>
        <p className={cx('whitespace-nowrap font-brand font-bold uppercase leading-none tracking-[0.05em]', size === 'lg' ? 'text-[22px]' : size === 'sm' ? 'text-[17px]' : 'text-[18px]',
          light ? 'text-white' : 'bg-gradient-to-r from-violet-600 to-indigo-600 bg-clip-text text-transparent')}>{APP_NAME}</p>
        <p className={cx('whitespace-nowrap uppercase leading-none', 'font-medium tracking-[0.125em]', size === 'lg' ? 'text-[12px]' : size === 'sm' ? 'text-[9.5px]' : 'text-[10px]',
          light ? 'text-white/70' : 'text-slate-500')}>{APP_ORG}</p>
      </div>
    </div>
  );
}

export function MadeWithLove({ className }) {
  return (
    <p className={cx('flex items-center justify-center gap-1 whitespace-nowrap', className)}>
      Made with <span className="text-rose-500" role="img" aria-label="love">❤</span> by {APP_ORG}
    </p>
  );
}

export function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function timeAgo(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month'], [Infinity, 'year']];
  let value = seconds;
  for (const [size, unit] of steps) {
    if (Math.abs(value) < size) return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-Math.round(value), unit);
    value /= size;
  }
  return '';
}

const BUTTON_VARIANTS = {
  primary: 'bg-voice text-white shadow-glow hover:brightness-110 disabled:opacity-50 disabled:shadow-none',
  secondary: 'bg-white text-slate-700 ring-1 ring-inset ring-slate-200 shadow-sm hover:bg-slate-50 disabled:text-slate-400',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:text-slate-300',
  danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-700 disabled:bg-rose-300',
  success: 'bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 disabled:bg-emerald-300',
};
const BUTTON_SIZES = { sm: 'h-8 px-2.5 text-xs gap-1.5', md: 'h-10 px-4 text-sm gap-2', lg: 'h-12 px-5 text-sm gap-2' };

export function Button({ variant = 'primary', size = 'md', icon: Icon, loading, className, children, href, ...props }) {
  const classes = cx('inline-flex shrink-0 items-center justify-center rounded-xl font-semibold transition active:scale-[0.97] disabled:cursor-not-allowed disabled:active:scale-100',
    BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className);
  const content = <>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : Icon && <Icon className="h-4 w-4" />}{children}</>;
  if (href && !props.disabled) return <a href={href} className={classes} {...props}>{content}</a>;
  return (
    <button type="button" className={classes} disabled={loading || props.disabled} {...props}>
      {content}
    </button>
  );
}

export function Badge({ tone, icon: Icon, children, className }) {
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset', tone, className)}>
      {Icon && <Icon className="h-3 w-3" />}
      {children}
    </span>
  );
}

export function Avatar({ name = '', size = 'md' }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join('') || '?';
  const palette = [
    'from-violet-500 to-indigo-600', 'from-fuchsia-500 to-pink-600', 'from-emerald-400 to-teal-600',
    'from-sky-400 to-blue-600', 'from-amber-400 to-orange-600', 'from-rose-400 to-red-600',
  ];
  const color = palette[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % palette.length];
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-semibold text-white shadow-sm', color,
      { sm: 'h-7 w-7 text-[11px]', md: 'h-9 w-9 text-xs', lg: 'h-12 w-12 text-base' }[size])}>
      {initials}
    </span>
  );
}

export function Spinner({ label = 'Loading…', variant = 'list', rows = 5 }) {
  if (variant === 'grid') {
    return (
      <div role="status" aria-label={label} className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="card overflow-hidden">
            <Bone className="aspect-[16/10] rounded-none" />
            <div className="space-y-2 p-2 sm:p-3">
              <Bone className="h-3.5 w-3/4" /><Bone className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div role="status" aria-label={label} className="card divide-y divide-slate-100">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 p-4">
          <Bone className="h-10 w-10 shrink-0 rounded-xl" />
          <div className="flex-1 space-y-2"><Bone className="h-3.5" style={{ width: `${60 - (i % 3) * 12}%` }} /><Bone className="h-3 w-1/3" /></div>
          <Bone className="hidden h-8 w-20 rounded-lg sm:block" />
        </div>
      ))}
    </div>
  );
}

function Bone({ className, style }) {
  return (
    <div style={style} className={cx('relative overflow-hidden rounded-md bg-slate-200/70', className)}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/70 to-transparent" />
    </div>
  );
}

export function SplashLoader() {
  return (
    <div role="status" aria-label={`Loading ${APP_NAME}`} className="flex min-h-screen flex-col items-center justify-center gap-6 bg-voice-soft">
      <div className="relative">
        <div className="absolute inset-0 animate-ping rounded-3xl bg-brand-400/30" />
        <LogoMark className="relative h-16 w-16 animate-breathe rounded-3xl shadow-glow" />
      </div>
      <div className="text-center">
        <p className="bg-gradient-to-r from-violet-600 to-indigo-600 bg-clip-text text-lg font-extrabold uppercase tracking-[0.12em] text-transparent">{APP_NAME}</p>
      </div>
      <div className="h-1 w-40 overflow-hidden rounded-full bg-brand-100">
        <div className="h-full w-2/5 animate-load-bar rounded-full bg-voice" />
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, action }) {
  return (
    <div className="card flex flex-col items-center px-6 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-voice text-white shadow-glow">
        <Icon className="h-7 w-7" />
      </div>
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, actions }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between lg:mb-6">
      <div className="min-w-0 flex-1">
        <h1 className="hidden text-2xl font-bold tracking-tight text-slate-900 lg:block">{title}</h1>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = event => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open, onClose]);
  if (!open) return null;
  const width = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className={cx('relative flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-pop animate-sheet-up sm:max-h-[90vh] sm:rounded-2xl sm:animate-fade-in', width)}>
        <div className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-slate-300 sm:hidden" aria-hidden="true" />
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-slate-900">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-slate-100 bg-slate-50/80 px-6 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-sm:pb-[max(1rem,env(safe-area-inset-bottom))] [&>*]:flex-1 sm:[&>*]:flex-none">{footer}</div>}
      </div>
    </div>
  );
}

const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const notify = useCallback((message, kind = 'success') => {
    const id = Math.random().toString(36).slice(2);
    setToasts(current => [...current, { id, message, kind }]);
    setTimeout(() => setToasts(current => current.filter(toast => toast.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  const icons = { success: CheckCircle2, error: AlertTriangle, info: Info };
  const tones = { success: 'text-emerald-400', error: 'text-rose-400', info: 'text-sky-400' };
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="pointer-events-none fixed inset-x-3 bottom-24 z-[60] flex flex-col items-center gap-2 lg:inset-x-auto lg:bottom-6 lg:right-6 lg:w-96" aria-live="polite">
        {toasts.map(toast => {
          const Icon = icons[toast.kind];
          return (
            <div key={toast.id} className="pointer-events-auto flex w-full items-start gap-3 rounded-xl bg-slate-900 px-4 py-3.5 text-white shadow-pop animate-fade-in">
              <Icon className={cx('mt-0.5 h-5 w-5 shrink-0', tones[toast.kind])} />
              <p className="text-sm text-slate-100">{toast.message}</p>
              <button type="button" className="ml-auto text-slate-400 hover:text-white" aria-label="Dismiss"
                onClick={() => setToasts(current => current.filter(item => item.id !== toast.id))}>
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useAsync(loader, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const reload = useCallback(async () => {
    setState(current => ({ ...current, loading: true, error: null }));
    try { setState({ loading: false, data: await loader(), error: null }); } catch (error) { setState({ loading: false, data: null, error }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

export function ErrorBanner({ error, onRetry }) {
  return (
    <div className="mb-4 flex items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="flex-1">{error.message}</span>
      {onRetry && <Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button>}
    </div>
  );
}
