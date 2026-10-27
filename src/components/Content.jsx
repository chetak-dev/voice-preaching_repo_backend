import React, { useEffect, useState } from 'react';
import { Bookmark, Check, Download, ExternalLink, Eye, Layers, Pencil, Play, Plus, Share2 } from 'lucide-react';
import { api, fileUrl, thumbnailUrl } from '../api.js';
import { useMediaPlayer } from './MediaPlayer.jsx';
import FullPreview from './FullPreview.jsx';
import { Badge, Button, Modal, STATUS_META, TYPE_META, cx, formatBytes, timeAgo } from './ui.jsx';
import { TagChips } from './Tags.jsx';
import DownloadButton from './DownloadButton.jsx';

const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

export const canShare = item => item.status === 'approved' && item.visibility !== 'private' && !item.parent_id;

// /s/<id> serves a link preview (title + thumbnail) to chat apps, then redirects into the app.
export function contentLink(item) {
  return new URL(`/s/${encodeURIComponent(item.id)}`, window.location.origin).toString();
}

/** Opens the native share sheet when available, otherwise copies the link. Returns 'shared', 'copied' or null. */
export async function shareContent(item) {
  const url = contentLink(item);
  if (navigator.share) {
    try { await navigator.share({ title: item.title, url }); return 'shared'; }
    catch (error) { if (error?.name === 'AbortError') return null; }
  }
  try { await navigator.clipboard.writeText(url); return 'copied'; }
  catch { window.prompt('Copy this link', url); return null; }
}

function ViewCount({ value, className }) {
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-1', className)} title={`${value || 0} ${value === 1 ? 'view' : 'views'}`}>
      <Eye className="h-3.5 w-3.5" />{value || 0}
    </span>
  );
}

export function ShareButton({ item, onShare, className }) {
  return (
    <button type="button" onClick={() => onShare(item)} aria-label={`Share ${item.title}`}
      className={cx('rounded-md p-1 text-slate-400 transition hover:text-slate-700', className)}>
      <Share2 className="h-4 w-4" />
    </button>
  );
}

export const youtubeId = url => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^(www\.|m\.)/, '');
    if (host === 'youtu.be') return parsed.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'music.youtube.com') {
      if (parsed.pathname === '/watch') return parsed.searchParams.get('v');
      const match = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/);
      return match?.[1] || null;
    }
  } catch { /* not a URL */ }
  return null;
};

export function ContentThumb({ item, className }) {
  const meta = TYPE_META[item.type] || TYPE_META.link;
  const [failure, setFailure] = useState({ key: '', count: 0 });
  // Sources in order of preference: stored thumbnail, then a direct snapshot of the media.
  const sources = [];
  if (item.has_thumb) sources.push({ kind: 'img', src: thumbnailUrl(item.id) });
  if (item.type === 'image') sources.push({ kind: 'img', src: fileUrl(item.id, true) });
  if (item.type === 'video') sources.push({ kind: 'video', src: `${fileUrl(item.id, true)}#t=1` });
  const yt = item.type === 'link' && youtubeId(item.url);
  if (yt) sources.push({ kind: 'img', src: `https://img.youtube.com/vi/${encodeURIComponent(yt)}/hqdefault.jpg` });
  const key = sources.map(entry => entry.src).join('|');
  const failed = failure.key === key ? failure.count : 0;
  const fail = () => setFailure({ key, count: failed + 1 });
  const source = sources[failed];
  if (source?.kind === 'img') {
    return <img key={source.src} src={source.src} alt="" loading="lazy" onError={fail} className={cx('bg-slate-100 object-cover', className)} />;
  }
  if (source?.kind === 'video') {
    return <video key={source.src} src={source.src} preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true" onError={fail}
      className={cx('pointer-events-none bg-slate-900 object-cover', className)} />;
  }
  const Icon = meta.icon;
  const host = item.type === 'link' ? hostOf(item.url) : '';
  return (
    <div className={cx('flex flex-col items-center justify-center gap-1.5 bg-gradient-to-br', meta.tile, className)}>
      <Icon className="h-8 w-8 opacity-90 drop-shadow" strokeWidth={1.5} />
      {host && <span className="max-w-[85%] truncate text-[11px] font-semibold text-white/90">{host}</span>}
    </div>
  );
}

export function ContentCard({ item, onPreview, onBookmark, onShare, showStatus, footer, className }) {
  const meta = TYPE_META[item.type] || TYPE_META.link;
  const { openPlayer } = useMediaPlayer();
  const playable = (item.type === 'audio' || item.type === 'video') && item.status !== 'rejected';
  return (
    <article className={cx('card group flex flex-col overflow-hidden transition duration-200 hover:-translate-y-0.5 hover:shadow-pop', className)}>
      <div className="relative">
      <button type="button" onClick={() => onPreview(item)} className="relative block aspect-[16/10] w-full overflow-hidden" aria-label={`Preview ${item.title}`}>
        <ContentThumb item={item} className="h-full w-full transition duration-300 group-hover:scale-[1.03]" />
        <span className="absolute left-1.5 top-1.5 sm:left-2 sm:top-2"><Badge tone={cx(meta.tone, 'bg-white/90 px-1.5 py-0.5 text-[10px] backdrop-blur [&_svg]:h-3 [&_svg]:w-3')} icon={meta.icon}><span>{meta.label}</span></Badge></span>
        {item.parts > 0 && (
          <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-slate-900/75 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
            <Layers className="h-3 w-3" />+{item.parts}
          </span>
        )}
      </button>
      {playable && (
        <button type="button" onClick={() => openPlayer(item)} aria-label={`Play ${item.title} while browsing`} title="Play while browsing"
          className="absolute bottom-1.5 left-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-white/95 text-brand-700 shadow-md ring-1 ring-black/5 transition hover:scale-105 active:scale-95 sm:bottom-2 sm:left-2">
          <Play className="ml-0.5 h-4 w-4" fill="currentColor" />
        </button>
      )}
      </div>
      <div className="flex flex-1 flex-col p-2 sm:p-3">
        {item.parent_title && <p className="mb-0.5 truncate text-[11px] font-medium text-brand-700">Added to: {item.parent_title}</p>}
        <h3 className="line-clamp-2 text-xs font-semibold leading-snug text-slate-900 sm:text-[13px]" title={item.title}>{item.title}</h3>
        {item.description && <p className="mt-0.5 hidden text-xs text-slate-500 sm:line-clamp-1">{item.description}</p>}
        {item.snippet && <p className="mt-1 line-clamp-2 text-[11px] italic leading-snug text-slate-500" title="Found inside the document">{item.snippet}</p>}
        {showStatus && (
          <div className="mt-2"><Badge tone={STATUS_META[item.status].tone} className="px-1.5 py-0.5 text-[10px]">{STATUS_META[item.status].label}</Badge></div>
        )}
        {showStatus && item.status === 'rejected' && item.review_note && (
          <p className="mt-1.5 line-clamp-2 rounded-md bg-rose-50 px-2 py-1 text-[11px] text-rose-800"><span className="font-medium">Reviewer note:</span> {item.review_note}</p>
        )}
        <div className="mt-auto flex items-center gap-1.5 pt-1.5 text-[10px] text-slate-500 sm:pt-2 sm:text-[11px]">
          <span className="min-w-0 truncate">{item.uploader}</span>
          <span className="hidden shrink-0 2xl:inline">· {timeAgo(item.created_at)}</span>
          <span className="-mr-1 ml-auto flex shrink-0 items-center gap-0.5">
            {item.status === 'approved' && <ViewCount value={item.views} className="mr-0.5 [&_svg]:h-3 [&_svg]:w-3" />}
            {onShare && canShare(item) && <ShareButton item={item} onShare={onShare} className="p-0.5 [&_svg]:h-3.5 [&_svg]:w-3.5" />}
            {onBookmark && (
              <button type="button" onClick={() => onBookmark(item)} aria-label={item.bookmarked ? 'Remove from saved' : 'Save'} aria-pressed={Boolean(item.bookmarked)}
                className={cx('rounded-md p-0.5 transition active:scale-90', item.bookmarked ? 'text-brand-600' : 'text-slate-400 hover:text-slate-700')}>
                <Bookmark className="h-3.5 w-3.5" fill={item.bookmarked ? 'currentColor' : 'none'} />
              </button>
            )}
          </span>
        </div>
        {footer && <div className="mt-2 border-t border-slate-100 pt-1.5">{footer}</div>}
      </div>
    </article>
  );
}

function UploadParts({ item, user, onAddTo }) {
  const { openPlayer } = useMediaPlayer();
  const [parts, setParts] = useState(null);
  useEffect(() => {
    let live = true;
    setParts(null);
    api(`/content/${item.id}/parts`).then(data => live && setParts(data.items)).catch(() => live && setParts([]));
    return () => { live = false; };
  }, [item.id]);
  const canAdd = onAddTo && user && (item.status === 'approved' || (item.uploader_id === user.id && item.status === 'pending'));
  if (!parts?.length && !canAdd) return null;
  return (
    <section className="mt-5 border-t border-slate-100 pt-4" aria-label="Files in this upload">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
          <Layers className="h-4 w-4 text-slate-400" /> More in this upload{parts?.length ? ` (${parts.length})` : ''}
        </h3>
        {canAdd && <Button variant="secondary" size="sm" icon={Plus} onClick={() => onAddTo(item)}>Add files</Button>}
      </div>
      {parts === null ? (
        <div className="space-y-2" role="status" aria-label="Loading">
          {[0, 1].map(i => <div key={i} className="h-12 animate-pulse rounded-xl bg-slate-100" />)}
        </div>
      ) : !parts.length ? (
        <p className="text-sm text-slate-500">Have another part, slides or a related link? Add it here. It will appear after admin approval.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {parts.map(part => {
            const meta = TYPE_META[part.type] || TYPE_META.link;
            const media = part.type === 'audio' || part.type === 'video';
            const href = part.type === 'link' ? part.url : fileUrl(part.id, Boolean(MIME_INLINE[part.mime]));
            return (
              <li key={part.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', meta.tone)}><meta.icon className="h-4 w-4" /></div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">{part.title}</p>
                  <p className="truncate text-xs text-slate-500">
                    {part.type === 'link' ? hostOf(part.url) : formatBytes(part.size)} · {part.uploader}
                  </p>
                </div>
                {part.status !== 'approved' && <Badge tone={STATUS_META[part.status].tone}>{STATUS_META[part.status].label}</Badge>}
                {media ? (
                  <button type="button" onClick={() => openPlayer(part)} className="rounded-lg p-2 text-brand-700 hover:bg-brand-50" aria-label={`Play ${part.title}`}><Play className="h-4 w-4" /></button>
                ) : (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="rounded-lg p-2 text-brand-700 hover:bg-brand-50" aria-label={`Open ${part.title}`}>
                    {part.type === 'link' ? <ExternalLink className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </a>
                )}
                {part.type !== 'link' && (
                  <a href={fileUrl(part.id)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label={`Download ${part.title}`}><Download className="h-4 w-4" /></a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const MIME_INLINE = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'application/pdf': 1, 'text/plain': 1 };

export function EditContentModal({ item, onClose, onSaved }) {
  const [title, setTitle] = useState(item?.title || '');
  const [description, setDescription] = useState(item?.description || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setTitle(item?.title || ''); setDescription(item?.description || ''); setError(''); }, [item?.id]);
  async function submit(event) {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const saved = await api(`/content/${item.id}`, { method: 'PATCH', body: { title: title.trim(), description: description.trim() } });
      onSaved({ title: saved.title, description: saved.description });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Modal open={Boolean(item)} onClose={busy ? () => {} : onClose} size="md" title="Edit details"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="edit-content-form" icon={Check} loading={busy} disabled={!title.trim()}>Save</Button>
        </>
      )}>
      <form id="edit-content-form" onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="label">Title</span>
          <input className="input" value={title} onChange={e => setTitle(e.target.value)} maxLength={160} autoFocus required />
        </label>
        <label className="block">
          <span className="label">Description</span>
          <textarea className="input min-h-[96px]" value={description} onChange={e => setDescription(e.target.value)} maxLength={2000} placeholder="Optional" />
        </label>
        {error && <p className="text-sm text-rose-600">{error}</p>}
      </form>
    </Modal>
  );
}

export function PreviewModal({ item, onClose, actions, onShare, user, onAddTo, onEdited, onPickTag }) {
  const { openPlayer } = useMediaPlayer();
  const [editing, setEditing] = useState(null);
  if (!item) return null;
  const canEdit = onEdited && ['site_admin', 'org_admin'].includes(user?.role);
  if (canEdit && editing) {
    return <EditContentModal item={editing} onClose={() => setEditing(null)} onSaved={changes => { setEditing(null); onEdited(item, changes); }} />;
  }
  const meta = TYPE_META[item.type] || TYPE_META.link;
  const isMedia = item.type === 'audio' || item.type === 'video';
  return (
    <Modal open onClose={onClose} title={item.title} size="lg" footer={(
      <>
        {onShare && canShare(item) && <Button variant="secondary" icon={Share2} onClick={() => onShare(item)}>Share</Button>}
        {isMedia && <Button variant="secondary" icon={Play} onClick={() => { openPlayer(item); onClose(); }}>Keep playing while browsing</Button>}
        {isMedia && <DownloadButton item={item} />}
        {canEdit && <Button variant="secondary" icon={Pencil} onClick={() => setEditing(item)}>Edit</Button>}
        {actions}
        {item.type === 'link' ? <Button href={item.url} target="_blank" rel="noopener noreferrer" icon={ExternalLink}>Open link</Button>
          : <Button href={fileUrl(item.id)} icon={Download}>Download</Button>}
      </>
    )}>
      <FullPreview item={item} />
      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-5">
        <div><dt className="text-slate-500">Type</dt><dd className="font-medium text-slate-900">{meta.label}</dd></div>
        <div><dt className="text-slate-500">Submitted by</dt><dd className="truncate font-medium text-slate-900">{item.uploader}</dd></div>
        <div><dt className="text-slate-500">Submitted</dt><dd className="font-medium text-slate-900">{new Date(item.created_at).toLocaleDateString()}</dd></div>
        <div><dt className="text-slate-500">{item.type === 'link' ? 'Website' : 'Size'}</dt><dd className="truncate font-medium text-slate-900">{item.type === 'link' ? hostOf(item.url) : formatBytes(item.size)}</dd></div>
        {item.status === 'approved' && <div><dt className="text-slate-500">Views</dt><dd className="font-medium text-slate-900"><ViewCount value={item.views} /></dd></div>}
      </dl>
      {item.description && <p className="mt-4 whitespace-pre-line text-sm text-slate-600">{item.description}</p>}
      <TagChips item={item} onPick={onPickTag ? (key, value) => { onClose(); onPickTag(key, value); } : undefined} className="mt-4" />
      {item.parent_title && <p className="mt-4 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-900">Added to the upload <span className="font-semibold">“{item.parent_title}”</span></p>}
      {!item.parent_id && item.status !== 'rejected' && <UploadParts item={item} user={user} onAddTo={onAddTo} />}

    </Modal>
  );
}

export function PreviewButton({ onClick }) {
  return <Button variant="secondary" size="sm" icon={Eye} onClick={onClick}>Preview</Button>;
}
