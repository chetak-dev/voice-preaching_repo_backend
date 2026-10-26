import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, CloudOff, Copy, FileUp, Layers, Lightbulb, Link2, Plus, UploadCloud, X } from 'lucide-react';
import { api } from '../api.js';
import { enqueue, forget } from '../uploads.js';
import { makeThumbnail } from '../thumbnails.js';
import UploadTray from '../components/UploadTray.jsx';
import { youtubeId } from '../components/Content.jsx';
import { Button, PageHeader, TYPE_META, cx, formatBytes, useToast } from '../components/ui.jsx';

const fileTypeOf = file => ['image', 'video', 'audio'].find(type => file.type.startsWith(`${type}/`)) || 'doc';
const titleFromName = name => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 160);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
let nextKey = 0;

// Thumbnails are made one file at a time so a large batch of videos doesn't overwhelm the device.
let thumbChain = Promise.resolve();
const queueThumbnail = file => { const next = thumbChain.then(() => makeThumbnail(file)); thumbChain = next.catch(() => {}); return next; };

function QueueThumb({ item, compact }) {
  const Icon = TYPE_META[item.type].icon;
  return (
    <div className={cx('relative shrink-0 overflow-hidden rounded-lg ring-1 ring-slate-200', compact ? 'h-9 w-14' : 'h-16 w-24 sm:h-20 sm:w-32')}>
      {item.thumbUrl
        ? <img src={item.thumbUrl} alt="" className="h-full w-full bg-slate-100 object-cover" />
        : (
          <span className={cx('flex h-full w-full items-center justify-center bg-gradient-to-br', TYPE_META[item.type].tile)}>
            <Icon className={compact ? 'h-4 w-4' : 'h-6 w-6'} strokeWidth={1.75} />
          </span>
        )}
    </div>
  );
}

function QueueItem({ item, index, locked, compact, canCopy, onChange, onRemove, onCopyDescription }) {
  const done = item.status === 'done';
  return (
    <li className={cx('rounded-xl border', compact ? 'p-2.5' : 'p-3 sm:p-4', done ? 'border-emerald-200 bg-emerald-50/50' : item.status === 'error' ? 'border-rose-200' : 'border-slate-200')}>
      <div className={cx('flex gap-3', compact ? 'items-center' : 'items-start')}>
        <QueueThumb item={item} compact={compact} />
        <div className="min-w-0 flex-1 space-y-2">
          <p className={cx('flex items-center gap-2', compact ? 'text-sm text-slate-700' : 'pt-0.5 text-xs text-slate-500')}>
            <span className="truncate">{item.kind === 'file' ? `${item.file.name} · ${formatBytes(item.file.size)}` : item.url}</span>
          </p>
          {!compact && <>
          <input required maxLength={160} className="input" aria-label={`Title ${index + 1}`} disabled={locked || done}
            placeholder="Title, e.g. Karma Yoga – Bhagavad Gita 3.19 | Sunday class"
            value={item.title} onChange={e => onChange({ title: e.target.value })} />
          <textarea rows={2} maxLength={2000} className="input resize-y" aria-label={`Description ${index + 1}`} disabled={locked || done}
            placeholder="Description, e.g. A talk on selfless action from Bhagavad Gita 3.19–30. Speaker: Name. Language: Hindi."
            value={item.description} onChange={e => onChange({ description: e.target.value })} />
          </>}
          {!compact && canCopy && item.description.trim() && !locked && !done && (
            <button type="button" onClick={onCopyDescription} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:text-brand-800">
              <Copy className="h-3.5 w-3.5" /> Use this description for all
            </button>
          )}
          {(item.status === 'uploading' || item.status === 'waiting') && (
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                <div className={cx('h-full rounded-full transition-all', item.status === 'waiting' ? 'bg-amber-400' : 'bg-voice')} style={{ width: `${item.progress}%` }} />
              </div>
              <span className="w-9 text-right text-xs tabular-nums text-slate-500">{item.progress}%</span>
            </div>
          )}
          {item.status === 'waiting' && <p className="flex items-center gap-1.5 text-xs text-amber-700"><CloudOff className="h-3.5 w-3.5 shrink-0" />Waiting for connection… it will continue automatically.</p>}
          {item.status === 'error' && <p className="flex items-center gap-1.5 text-xs text-rose-700"><AlertCircle className="h-3.5 w-3.5 shrink-0" />{item.error}</p>}
        </div>
        {done ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-label="Submitted" /> : !locked && (
          <button type="button" onClick={onRemove} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label={`Remove ${item.title || 'item'}`}>
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </li>
  );
}

export default function Upload({ user, navigate, onChanged, parent, onClearParent }) {
  const toast = useToast();
  const inputRef = useRef(null);
  const [mode, setMode] = useState('file');
  const [items, setItems] = useState([]);
  const [links, setLinks] = useState('');
  const [dragging, setDragging] = useState(false);
  const [target, setTarget] = useState('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(0);
  const [published, setPublished] = useState(false);
  const [storage, setStorage] = useState(null);
  const [sameForAll, setSameForAll] = useState(false);
  const [shared, setShared] = useState({ title: '', description: '' });
  const isAdmin = user.role === 'site_admin';
  const useShared = sameForAll && items.length > 1;

  useEffect(() => { if (isAdmin) api('/storage').then(setStorage).catch(() => {}); }, [isAdmin]);

  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const update = (key, patch) => setItems(list => list.map(item => (item.key === key ? { ...item, ...patch } : item)));
  const thumbUrls = useRef(new Set());
  useEffect(() => () => thumbUrls.current.forEach(url => URL.revokeObjectURL(url)), []);

  useEffect(() => {
    if (items.length < 2) { setSameForAll(false); setShared({ title: '', description: '' }); }
  }, [items.length]);

  function addFiles(fileList) {
    const files = [...(fileList || [])];
    const empty = files.filter(file => !file.size).length;
    setError(empty ? `${plural(empty, 'empty file')} skipped.` : '');
    const added = files.filter(file => file.size).map(file => ({
      key: ++nextKey, kind: 'file', file, type: fileTypeOf(file), title: titleFromName(file.name), description: '', status: 'ready', progress: 0,
    }));
    setItems(list => [...list, ...added]);
    for (const item of added) {
      queueThumbnail(item.file).then(thumb => {
        if (!thumb || !mounted.current) return;
        const thumbUrl = URL.createObjectURL(thumb);
        thumbUrls.current.add(thumbUrl);
        update(item.key, { thumb, thumbUrl });
      });
    }
  }

  function addLinks() {
    const withScheme = value => (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    const urls = [...new Set(links.split(/\s+/).filter(Boolean).map(withScheme))];
    const invalid = urls.find(url => {
      try { const parsed = new URL(url); return !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password; } catch { return true; }
    });
    if (!urls.length) return;
    if (invalid) { setError(`"${invalid}" is not a valid link.`); return; }
    setError('');
    setItems(list => [...list, ...urls.map(url => {
      const yt = youtubeId(url);
      return { key: ++nextKey, kind: 'link', url, type: 'link', title: parent?.title || '', description: '', status: 'ready', progress: 0,
        thumbUrl: yt ? `https://img.youtube.com/vi/${encodeURIComponent(yt)}/hqdefault.jpg` : undefined };
    })]);
    setLinks('');
  }

  async function submit(event) {
    event.preventDefault();
    const pending = items.filter(item => item.status !== 'done');
    if (!pending.length) { setError('Add at least one file or link.'); return; }
    if (useShared ? !shared.title.trim() : pending.some(item => !item.title.trim())) { setError(useShared ? 'Enter a title.' : 'Every item needs a title.'); return; }
    setBusy(true);
    setError('');
    const results = await enqueue(pending.map(item => {
      const source = useShared ? shared : item;
      const fields = { title: source.title.trim(), description: source.description.trim(), ...(parent ? { parentId: parent.id } : {}) };
      update(item.key, { status: 'ready', progress: 0, error: '' });
      return {
        key: item.key, kind: item.kind, file: item.file, url: item.url, title: fields.title, thumbnail: item.thumb,
        fields: item.kind === 'file' && isAdmin ? { ...fields, targetDriveId: target } : fields,
        onUpdate: ({ status, progress, error: message }) => update(item.key, {
          status: status === 'queued' ? 'ready' : status, progress, error: status === 'error' ? message : '',
        }),
      };
    }));
    const ok = results.filter(result => result.status === 'done').length;
    const failed = results.length - ok;
    if (!mounted.current) return;
    forget(results.map(result => result.id));
    setBusy(false);
    if (ok) onChanged?.();
    setPublished(results.some(result => result.contentStatus === 'approved'));
    if (failed) {
      setError(`${plural(failed, 'item')} could not be submitted. Fix and submit again.`);
      toast(`${plural(failed, 'item')} failed`, 'error');
    } else {
      setSubmitted(items.length - pending.length + ok);
    }
  }

  function reset() {
    setSubmitted(0); setItems([]); setLinks(''); setError(''); setMode('file'); setSameForAll(false); setShared({ title: '', description: '' });
  }

  if (submitted) {
    return (
      <div className="mx-auto max-w-lg">
        <div className="card p-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><CheckCircle2 className="h-7 w-7" /></div>
          <h2 className="text-lg font-semibold text-slate-900">
            {parent ? `${plural(submitted, 'item')} added to “${parent.title}”` : `${plural(submitted, 'item')} ${published ? 'published' : 'submitted for review'}`}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {published ? 'As an admin, your contributions are live in the library right away.'
              : parent ? 'They will appear in that upload after admin approval.' : 'You’ll see them in the library once an admin approves them.'}
          </p>
          <div className="mt-6 flex justify-center gap-2">
            <Button variant="secondary" onClick={() => navigate(parent || published ? 'library' : 'mine')}>{parent || published ? 'Go to library' : 'My submissions'}</Button>
            <Button icon={UploadCloud} onClick={reset}>{parent ? 'Add more' : 'Upload more'}</Button>
          </div>
        </div>
      </div>
    );
  }

  const destinations = storage ? [storage.local, ...storage.nodes].filter(node => node?.connected) : [];
  const remaining = items.filter(item => item.status !== 'done');
  const totalBytes = remaining.reduce((sum, item) => sum + (item.file?.size || 0), 0);
  const current = items.findIndex(item => item.status === 'uploading' || item.status === 'waiting');

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={parent ? 'Add to upload' : 'Contribute'} />
      {!busy && <UploadTray inline />}

      {parent && (
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-white p-3 ring-1 ring-brand-200">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Layers className="h-4 w-4" /></div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-slate-500">Adding files and links to</p>
            <p className="truncate text-sm font-semibold text-slate-900">{parent.title}</p>
          </div>
          {!busy && <button type="button" onClick={onClearParent} className="shrink-0 text-xs font-medium text-slate-500 hover:text-slate-800">New upload instead</button>}
        </div>
      )}

      <div className="mb-4 flex gap-3 rounded-xl bg-brand-50 p-3 text-sm text-brand-900 ring-1 ring-brand-100">
        <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
        <p>Give a clear title and description so preachers can easily find this content. Mention the topic, Gita verses, speaker, language and occasion.</p>
      </div>

      <form onSubmit={submit} className="card overflow-hidden">
        <div className="flex border-b border-slate-200">
          {[['file', FileUp, 'Upload files'], ['link', Link2, 'Share links']].map(([key, Icon, label]) => (
            <button key={key} type="button" onClick={() => setMode(key)}
              className={cx('flex flex-1 items-center justify-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition',
                mode === key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>

        <div className="space-y-5 p-4 sm:p-6">
          {mode === 'file' ? (
            <div
              role="button" tabIndex={0} aria-disabled={busy}
              onClick={() => !busy && inputRef.current?.click()}
              onKeyDown={e => !busy && (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); if (!busy) addFiles(e.dataTransfer.files); }}
              className={cx('flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed px-6 text-center transition',
                items.length ? 'py-5' : 'py-10',
                dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-300 hover:border-slate-400 hover:bg-slate-50',
                busy && 'pointer-events-none opacity-50')}>
              <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-600"><UploadCloud className="h-6 w-6" /></div>
              <p className="text-sm font-medium text-slate-900">Drop files here, or <span className="text-brand-700">browse</span></p>
              <p className="mt-1 text-xs text-slate-500">You can select many files at once</p>
              <input ref={inputRef} type="file" multiple className="hidden" onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
            </div>
          ) : (
            <div>
              <label className="label" htmlFor="links">Links</label>
              <textarea id="links" rows={3} className="input resize-y font-mono text-xs" disabled={busy}
                placeholder={'https://youtube.com/watch?v=…\nhttps://…\nOne link per line'}
                value={links} onChange={e => setLinks(e.target.value)} />
              <div className="mt-2 flex justify-end">
                <Button variant="secondary" size="sm" icon={Plus} onClick={addLinks} disabled={busy || !links.trim()}>Add links</Button>
              </div>
            </div>
          )}

          {items.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <p className="font-medium text-slate-900">
                  {busy ? `Submitting ${current + 1} of ${items.length}` : plural(items.length, 'item')}
                  {totalBytes > 0 && <span className="font-normal text-slate-500"> · {formatBytes(totalBytes)}</span>}
                </p>
                {!busy && <button type="button" onClick={() => { setItems(list => list.filter(item => item.status === 'done')); setError(''); }} className="text-xs font-medium text-slate-500 hover:text-rose-600">Clear all</button>}
              </div>
              {items.length > 1 && (
                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
                  <span className="text-sm font-medium text-slate-800">Same title and description for all</span>
                  <input type="checkbox" role="switch" className="sr-only" checked={sameForAll} disabled={busy}
                    onChange={e => {
                      const on = e.target.checked;
                      setSameForAll(on);
                      const first = remaining[0];
                      if (on && first && !shared.title && !shared.description) setShared({ title: first.title, description: first.description });
                    }} />
                  <span aria-hidden="true" className={cx('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors',
                    sameForAll ? 'bg-voice' : 'bg-slate-300')}>
                    <span className={cx('h-5 w-5 rounded-full bg-white shadow transition-transform', sameForAll && 'translate-x-5')} />
                  </span>
                </label>
              )}
              {useShared && (
                <div className="space-y-2 rounded-xl border border-brand-200 bg-brand-50/40 p-3 sm:p-4">
                  <input required maxLength={160} className="input" aria-label="Title for all" disabled={busy}
                    placeholder="Title for all, e.g. Gita class series – Chapter 2"
                    value={shared.title} onChange={e => setShared({ ...shared, title: e.target.value })} />
                  <textarea rows={3} maxLength={2000} className="input resize-y" aria-label="Description for all" disabled={busy}
                    placeholder="Description for all, e.g. Bhagavad Gita chapter 2 classes. Speaker: Name. Language: Hindi."
                    value={shared.description} onChange={e => setShared({ ...shared, description: e.target.value })} />
                </div>
              )}
              <ul className={useShared ? 'space-y-2' : 'space-y-3'}>
                {items.map((item, index) => (
                  <QueueItem key={item.key} item={item} index={index} locked={busy} compact={useShared} canCopy={remaining.length > 1}
                    onChange={patch => update(item.key, patch)}
                    onRemove={() => setItems(list => list.filter(other => other.key !== item.key))}
                    onCopyDescription={() => setItems(list => list.map(other => (other.status === 'done' ? other : { ...other, description: item.description })))} />
                ))}
              </ul>
            </div>
          )}

          {isAdmin && items.some(item => item.kind === 'file') && (
            <div>
              <label className="label" htmlFor="target">Storage destination</label>
              <select id="target" className="input" value={target} disabled={busy} onChange={e => setTarget(e.target.value)}>
                <option value="auto">Automatic</option>
                {destinations.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}
              </select>
            </div>
          )}

          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-4 py-4 sm:px-6">
          {busy && <p className="mr-auto text-xs text-slate-500">You can leave this page. Uploads continue in the background.</p>}
          {!busy && <Button variant="secondary" onClick={() => navigate('library')}>Cancel</Button>}
          <Button type="submit" icon={UploadCloud} loading={busy} disabled={!remaining.length}>
            {busy ? 'Uploading…' : remaining.length > 1 ? `Upload ${remaining.length} items` : 'Upload'}
          </Button>
        </div>
      </form>

    </div>
  );
}
