import React, { useState } from 'react';
import { Bookmark, BookmarkCheck, Download, ExternalLink, Eye } from 'lucide-react';
import { fileUrl } from '../api.js';
import { Avatar, Badge, Button, Modal, STATUS_META, TYPE_META, cx, formatBytes, timeAgo } from './ui.jsx';

const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

export function ContentThumb({ item, className }) {
  const meta = TYPE_META[item.type] || TYPE_META.link;
  const [failed, setFailed] = useState(false);
  if (item.type === 'image' && !failed) {
    return <img src={fileUrl(item.id, true)} alt="" loading="lazy" onError={() => setFailed(true)} className={cx('object-cover', className)} />;
  }
  const Icon = meta.icon;
  const host = item.type === 'link' ? hostOf(item.url) : '';
  return (
    <div className={cx('flex flex-col items-center justify-center gap-2 bg-gradient-to-br', meta.tile, className)}>
      <Icon className="h-10 w-10 opacity-90 drop-shadow" strokeWidth={1.5} />
      {host && <span className="max-w-[85%] truncate text-xs font-semibold text-white/90">{host}</span>}
    </div>
  );
}

export function ContentCard({ item, onPreview, onBookmark, showStatus, footer }) {
  const meta = TYPE_META[item.type] || TYPE_META.link;
  return (
    <article className="card group flex flex-col overflow-hidden transition duration-200 hover:-translate-y-1 hover:shadow-pop">
      <button type="button" onClick={() => onPreview(item)} className="relative block aspect-[16/10] w-full overflow-hidden" aria-label={`Preview ${item.title}`}>
        <ContentThumb item={item} className="h-full w-full transition duration-300 group-hover:scale-[1.02]" />
        <span className="absolute left-3 top-3"><Badge tone={cx(meta.tone, 'bg-white/90 backdrop-blur')} icon={meta.icon}>{meta.label}</Badge></span>
      </button>
      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 text-sm font-semibold text-slate-900">{item.title}</h3>
          {onBookmark && (
            <button type="button" onClick={() => onBookmark(item)} aria-label={item.bookmarked ? 'Remove from saved' : 'Save'}
              className={cx('-mr-1 -mt-0.5 rounded-md p-1 transition', item.bookmarked ? 'text-brand-600' : 'text-slate-400 hover:text-slate-700')}>
              {item.bookmarked ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
            </button>
          )}
        </div>
        {item.description && <p className="mt-1 line-clamp-2 text-sm text-slate-500">{item.description}</p>}
        {showStatus && (
          <div className="mt-3"><Badge tone={STATUS_META[item.status].tone}>{STATUS_META[item.status].label}</Badge></div>
        )}
        {showStatus && item.status === 'rejected' && item.review_note && (
          <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800"><span className="font-medium">Reviewer note:</span> {item.review_note}</p>
        )}
        <div className="mt-auto flex items-center gap-2 pt-4 text-xs text-slate-500">
          <Avatar name={item.uploader} size="sm" />
          <span className="truncate">{item.uploader}</span>
          <span className="ml-auto shrink-0">{timeAgo(item.created_at)}</span>
        </div>
        {footer && <div className="mt-4 border-t border-slate-100 pt-3">{footer}</div>}
      </div>
    </article>
  );
}

export function PreviewModal({ item, onClose, actions }) {
  if (!item) return null;
  const meta = TYPE_META[item.type] || TYPE_META.link;
  const src = fileUrl(item.id, true);
  let body;
  if (item.type === 'image') body = <img src={src} alt={item.title} className="mx-auto max-h-[60vh] rounded-lg object-contain" />;
  else if (item.type === 'video') body = <video src={src} controls className="max-h-[60vh] w-full rounded-lg bg-black" />;
  else if (item.type === 'audio') body = <div className="rounded-lg bg-slate-50 p-6"><audio src={src} controls className="w-full" /></div>;
  else if (item.type === 'doc') body = <iframe title={item.title} src={src} className="h-[60vh] w-full rounded-lg border border-slate-200" />;
  else {
    body = (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">External link</p>
        <p className="mt-1 break-all text-sm text-slate-800">{item.url}</p>
      </div>
    );
  }
  return (
    <Modal open onClose={onClose} title={item.title} size="lg"
      footer={(
        <>
          {actions}
          {item.type === 'link'
            ? <Button href={item.url} target="_blank" rel="noopener noreferrer" icon={ExternalLink}>Open link</Button>
            : <Button href={fileUrl(item.id)} icon={Download}>Download</Button>}
        </>
      )}>
      {body}
      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <div><dt className="text-slate-500">Type</dt><dd className="font-medium text-slate-900">{meta.label}</dd></div>
        <div><dt className="text-slate-500">Submitted by</dt><dd className="truncate font-medium text-slate-900">{item.uploader}</dd></div>
        <div><dt className="text-slate-500">Submitted</dt><dd className="font-medium text-slate-900">{new Date(item.created_at).toLocaleDateString()}</dd></div>
        <div><dt className="text-slate-500">{item.type === 'link' ? 'Website' : 'Size'}</dt>
          <dd className="truncate font-medium text-slate-900">{item.type === 'link' ? hostOf(item.url) : formatBytes(item.size)}</dd></div>
      </dl>
      {item.description && <p className="mt-4 whitespace-pre-line text-sm text-slate-600">{item.description}</p>}
    </Modal>
  );
}

export function PreviewButton({ onClick }) {
  return <Button variant="secondary" size="sm" icon={Eye} onClick={onClick}>Preview</Button>;
}
