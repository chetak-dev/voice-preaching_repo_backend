import React, { useEffect, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, HardDrive, Lock, Mail, ShieldCheck, User, Users } from 'lucide-react';
import { api } from '../api.js';
import { Button, Logo, cx } from '../components/ui.jsx';

const FEATURES = [
  [ShieldCheck, 'Moderated by design', 'Every contribution is reviewed by an admin before it is published.', 'from-emerald-400 to-teal-500'],
  [Users, 'Built for community', 'Members contribute, admins keep the library trustworthy.', 'from-sky-400 to-blue-500'],
  [HardDrive, 'Multi-Drive storage', 'Files are spread across multiple Google Drives automatically.', 'from-amber-400 to-orange-500'],
];

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

const modeFromHash = () => (window.location.hash === '#/signup' ? 'signup' : 'signin');

function Field({ id, label, icon: Icon, error, children }) {
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      <div className="relative">
        <Icon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        {children}
      </div>
      {error && <p className="mt-1.5 text-xs font-medium text-rose-600">{error}</p>}
    </div>
  );
}

export default function Login({ config, onSignedIn }) {
  const [mode, setMode] = useState(modeFromHash);
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signup = mode === 'signup';

  useEffect(() => {
    const sync = () => { setMode(modeFromHash()); setError(''); setForm(current => ({ ...current, password: '', confirm: '' })); };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  const mismatch = signup && form.confirm.length > 0 && form.confirm !== form.password;
  const tooShort = signup && form.password.length > 0 && form.password.length < 8;
  const canSubmit = signup
    ? form.name.trim().length >= 2 && form.email && form.password.length >= 8 && form.confirm === form.password
    : form.email && form.password;

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (signup && form.password !== form.confirm) return setError('Passwords do not match.');
    if (!canSubmit) return undefined;
    setBusy(true);
    try {
      await api(signup ? '/auth/signup' : '/auth/login', {
        method: 'POST',
        body: signup ? { name: form.name, email: form.email, password: form.password } : { email: form.email, password: form.password },
      });
      window.history.replaceState(null, '', '/');
      await onSignedIn();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const passwordToggle = (
    <button type="button" onClick={() => setShowPassword(value => !value)}
      className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-400 hover:text-slate-600"
      aria-label={showPassword ? 'Hide passwords' : 'Show passwords'}>
      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );

  return (
    <div className="flex min-h-screen flex-col bg-voice lg:grid lg:grid-cols-[1.1fr_1fr] lg:bg-none">
      {/* Brand panel: full hero on desktop, compact app header on mobile */}
      <div className="relative overflow-hidden bg-voice px-6 pb-16 pt-[max(2.5rem,env(safe-area-inset-top))] text-white lg:flex lg:flex-col lg:p-14">
        <div className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-amber-300/20 blur-3xl" />
        <div className="relative"><Logo size="lg" light /></div>
        <div className="relative mt-8 lg:mt-auto lg:max-w-lg">
          <h1 className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl lg:text-5xl">
            Every voice, <span className="text-amber-200">one trusted library.</span>
          </h1>
          <p className="mt-5 hidden text-base text-white/80 lg:block">
            Share lectures, audio, documents, images and links. Reviewed, organized and ready for your community.
          </p>
          <ul className="mt-10 hidden space-y-5 lg:block">
            {FEATURES.map(([Icon, title, text, tone]) => (
              <li key={title} className="flex gap-4 rounded-2xl bg-white/10 p-4 ring-1 ring-white/15 backdrop-blur-sm">
                <div className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-md', tone)}><Icon className="h-5 w-5" /></div>
                <div><p className="text-sm font-semibold">{title}</p><p className="text-sm text-white/70">{text}</p></div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-12 hidden text-xs text-white/50 lg:block">© {new Date().getFullYear()} VOICE</p>
      </div>

      {/* Form: rounded sheet on mobile, centered column on desktop */}
      <div className="relative -mt-8 flex flex-1 justify-center rounded-t-[2rem] bg-slate-50 px-6 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-8 shadow-nav lg:mt-0 lg:items-center lg:rounded-none lg:bg-white lg:py-12 lg:shadow-none">
        <div className="w-full max-w-sm">
          <div className="mb-6 grid grid-cols-2 rounded-2xl bg-slate-200/60 p-1 lg:bg-slate-100" role="tablist">
            {[['signin', 'Sign in'], ['signup', 'Sign up']].map(([id, label]) => (
              <a key={id} href={`#/${id}`} role="tab" aria-selected={mode === id}
                className={cx('rounded-xl py-2 text-center text-sm font-semibold transition',
                  mode === id ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
                {label}
              </a>
            ))}
          </div>

          <h2 className="text-2xl font-bold tracking-tight text-slate-900">{signup ? 'Create account' : 'Welcome back'}</h2>

          <Button href={config?.googleConfigured ? '/api/auth/google' : undefined} variant="secondary" size="lg" className="mt-6 w-full" disabled={!config?.googleConfigured}>
            <GoogleMark /> {signup ? 'Sign up with Google' : 'Continue with Google'}
          </Button>

          <div className="relative my-6 text-center text-xs font-medium text-slate-400">
            <span className="relative z-10 bg-slate-50 px-3 lg:bg-white">or</span>
            <div className="absolute inset-x-0 top-1/2 border-t border-slate-200" />
          </div>

          <form onSubmit={submit} className="space-y-4">
            {signup && (
              <Field id="auth-name" label="Full name" icon={User}>
                <input id="auth-name" className="input pl-10" autoComplete="name" required minLength={2} maxLength={100}
                  placeholder="Your name" value={form.name} onChange={set('name')} />
              </Field>
            )}
            <Field id="auth-email" label="Email" icon={Mail}>
              <input id="auth-email" type="email" inputMode="email" className="input pl-10" autoComplete="email" required
                placeholder="you@example.com" value={form.email} onChange={set('email')} />
            </Field>
            <Field id="auth-password" label="Password" icon={Lock}
              error={tooShort && 'Password must be at least 8 characters.'}>
              <input id="auth-password" type={showPassword ? 'text' : 'password'} className="input pl-10 pr-11" required
                autoComplete={signup ? 'new-password' : 'current-password'} maxLength={128}
                placeholder={signup ? 'Create a password' : 'Your password'} value={form.password} onChange={set('password')} />
              {passwordToggle}
            </Field>
            {signup && (
              <Field id="auth-confirm" label="Confirm password" icon={Lock} error={mismatch && 'Passwords do not match.'}>
                <input id="auth-confirm" type={showPassword ? 'text' : 'password'} required autoComplete="new-password" maxLength={128}
                  className={cx('input pl-10 pr-11', mismatch && '!border-rose-400 focus:!ring-rose-500/15')}
                  placeholder="Re-enter your password" value={form.confirm} onChange={set('confirm')} aria-invalid={mismatch || undefined} />
                {form.confirm && !mismatch && form.confirm === form.password && (
                  <CheckCircle2 className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-emerald-500" aria-label="Passwords match" />
                )}
              </Field>
            )}
            {error && <p role="alert" className="rounded-xl bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">{error}</p>}
            <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!canSubmit}>
              {signup ? 'Create account' : 'Sign in'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
