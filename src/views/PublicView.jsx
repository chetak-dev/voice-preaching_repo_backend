import React, { useEffect, useState } from 'react';
import { Download, ExternalLink, Eye, Layers, LogIn, SearchX, UserPlus } from 'lucide-react';
import { api, fileUrl } from '../api.js';
import { ContentThumb } from '../components/Content.jsx';
import FullPreview from '../components/FullPreview.jsx';
import { APP_NAME, Badge, Button, Logo, MadeWithLove, Modal, Spinner, TYPE_META, cx, formatBytes } from '../components/ui.jsx';

// Remembers which shared item to open once the visitor has signed in (the Google sign-in redirect drops the link).
export const PENDING_CONTENT_KEY = 'voice.pendingContent';
// Fixed colours: these sit on the brand gradient, which looks the same in light and dark themes.
const pill = 'rounded-full bg-[#fff] text-sm font-semibold text-[#6d28d9] shadow-sm transition hover:bg-[#f5f3ff] active:scale-95';

/** What someone sees when they open a shared link without being signed in: they can view and download it freely. */
export default function PublicView({ contentId, onSignIn }) {
  const [state, setState] = useState({ loading: true, item: null, parts: [], error: null });
  const [viewing, setViewing] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    api(`/public/content/${encodeURIComponent(contentId)}`, { signal: controller.signal })
      .then(data => setState({ loading: false, item: data.item, parts: data.parts, error: null }))
      .catch(error => { if (error.name !== 'AbortError') setState({ loading: false, item: null, parts: [], error }); });
    return () => controller.abort();
  }, [contentId]);

  useEffect(() => {
    if (state.item) document.title = `${state.item.title} · Kalpa Taru`;
  }, [state.item]);

  const signIn = mode => {
    sessionStorage.setItem(PENDING_CONTENT_KEY, contentId);
    onSignIn(mode);
  };
  const { item, parts } = state;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="pt-safe sticky top-0 z-30 bg-voice text-white shadow-md">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4 sm:h-16 sm:px-6">
          <Logo size="sm" light />
          <div className="flex-1" />
          <button type="button" onClick={() => signIn('signin')}
            className="rounded-full px-3 py-1.5 text-sm font-semibold text-white/90 transition hover:bg-white/15 hover:text-white">
            Sign in
          </button>
          <button type="button" onClick={() => signIn('signup')}
            className={cx(pill, 'px-3.5 py-1.5')}>
            <span className="sm:hidden">Join free</span><span className="hidden sm:inline">Create free account</span>
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-16 pt-5 sm:px-6 sm:pt-8">
        {state.loading && <Spinner rows={3} />}
        {state.error && (
          <div className="card mx-auto mt-6 flex max-w-md flex-col items-center gap-3 p-8 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-500"><SearchX className="h-7 w-7" /></span>
            <h1 className="text-lg font-semibold text-slate-900">{state.error.status === 404 ? 'This content isn’t available' : 'Something went wrong'}</h1>
            <p className="text-sm text-slate-500">
              {state.error.status === 404
                ? 'It may have been removed or is only visible to members. Sign in to see everything in the library.'
                : state.error.message}
            </p>
            <div className="mt-2 flex gap-2">
              <Button variant="secondary" icon={LogIn} onClick={() => signIn('signin')}>Sign in</Button>
              <Button icon={UserPlus} onClick={() => signIn('signup')}>Create account</Button>
            </div>
          </div>
        )}
        {item && (
          <article className="space-y-5">
            <div className="card overflow-hidden">
              <div className="p-3 sm:p-5"><FullPreview item={item} /></div>
              <div className="border-t border-slate-100 p-4 sm:p-6">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <Badge tone={(TYPE_META[item.type] || TYPE_META.link).tone}>{(TYPE_META[item.type] || TYPE_META.link).label}</Badge>
                    <h1 className="mt-2 break-words text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">{item.title}</h1>
                    <p className="mt-1 text-sm text-slate-500">
                      Shared by <span className="font-medium text-slate-700">{item.uploader}</span> · {new Date(item.created_at).toLocaleDateString()}
                      {item.type !== 'link' && item.size ? ` · ${formatBytes(item.size)}` : ''}
                    </p>
                  </div>
                  {item.type === 'link'
                    ? <Button href={item.url} target="_blank" rel="noopener noreferrer" icon={ExternalLink} className="w-full sm:w-auto">Open link</Button>
                    : <Button href={fileUrl(item.id)} icon={Download} className="w-full sm:w-auto">Download</Button>}
                </div>
                {item.description && <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-slate-600">{item.description}</p>}
              </div>
            </div>

            {parts.length > 0 && (
              <section className="card p-4 sm:p-5">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <Layers className="h-4 w-4 text-slate-400" />More in this upload ({parts.length})
                </h2>
                <ul className="mt-3 divide-y divide-slate-100">
                  {parts.map(part => (
                    <li key={part.id} className="flex items-center gap-3 py-2.5">
                      <ContentThumb item={part} className="h-12 w-16 shrink-0 rounded-lg" />
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 break-words text-sm font-medium text-slate-900">{part.title}</p>
                        <p className="text-xs text-slate-500">{(TYPE_META[part.type] || TYPE_META.link).label}{part.size ? ` · ${formatBytes(part.size)}` : ''}</p>
                      </div>
                      <button type="button" onClick={() => setViewing(part)} aria-label={`View ${part.title}`}
                        className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm font-medium text-brand-700 transition hover:bg-brand-50">
                        <Eye className="h-4 w-4" /><span className="hidden sm:inline">View</span>
                      </button>
                      {part.type !== 'link' && (
                        <a href={fileUrl(part.id)} aria-label={`Download ${part.title}`}
                          className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100">
                          <Download className="h-4 w-4" />
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="relative overflow-hidden rounded-3xl bg-voice p-6 text-white shadow-glow sm:p-8">
              <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-white/10 blur-3xl" />
              <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-bold">Discover more like this</h2>
                  <p className="mt-1 text-sm text-white/80">Create a free account to explore the whole {APP_NAME} library, save favourites and share your own content.</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" onClick={() => signIn('signin')}
                    className="rounded-xl px-4 py-2.5 text-sm font-semibold text-white ring-1 ring-inset ring-white/50 transition hover:bg-white/15 active:scale-95">
                    Sign in
                  </button>
                  <button type="button" onClick={() => signIn('signup')} className={cx(pill, 'rounded-xl px-4 py-2.5')}>Create account</button>
                </div>
              </div>
            </section>
          </article>
        )}
      </main>
      <footer className="pb-safe px-4 pb-6 text-center text-xs text-slate-500">
        <MadeWithLove />
        <p className="mt-1.5 flex justify-center gap-2">
          <a href="#/privacy" className="hover:text-brand-700">Privacy Policy</a>·<a href="#/terms" className="hover:text-brand-700">Terms & Conditions</a>
        </p>
      </footer>

      <Modal open={Boolean(viewing)} onClose={() => setViewing(null)} title={viewing?.title} size="lg"
        footer={viewing && (viewing.type === 'link'
          ? <Button href={viewing.url} target="_blank" rel="noopener noreferrer" icon={ExternalLink}>Open link</Button>
          : <Button href={fileUrl(viewing.id)} icon={Download}>Download</Button>)}>
        {viewing && <FullPreview item={viewing} />}
      </Modal>

    </div>
  );
}
