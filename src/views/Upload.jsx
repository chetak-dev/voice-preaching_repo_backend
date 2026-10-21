import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileUp, Link2, UploadCloud, X } from 'lucide-react';
import { api, uploadFile } from '../api.js';
import { Button, PageHeader, TYPE_META, cx, formatBytes, useToast } from '../components/ui.jsx';

const fileTypeOf = file => ['image', 'video', 'audio'].find(type => file.type.startsWith(`${type}/`)) || 'doc';

export default function Upload({ user, config, navigate, onChanged }) {
  const toast = useToast();
  const inputRef = useRef(null);
  const [mode, setMode] = useState('file');
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', url: '', target: 'auto' });
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [storage, setStorage] = useState(null);
  const isAdmin = user.role === 'site_admin';

  useEffect(() => { if (isAdmin) api('/storage').then(setStorage).catch(() => {}); }, [isAdmin]);

  const fileType = file && fileTypeOf(file);
  const maxBytes = (config?.maxUploadMB || 100) * 1024 * 1024;

  function pick(selected) {
    setError('');
    if (!selected) return;
    if (!selected.size) { setError('Empty files cannot be uploaded.'); return; }
    if (selected.size > maxBytes) { setError(`File exceeds the ${config.maxUploadMB} MB limit.`); return; }
    setFile(selected);
    if (!form.title) setForm(current => ({ ...current, title: selected.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 160) }));
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    try {
      if (mode === 'file') {
        if (!file) { setError('Choose a file to upload.'); return; }
        setProgress(0);
        await uploadFile(file, {
          title: form.title, description: form.description, ...(isAdmin ? { targetDriveId: form.target } : {}),
        }, setProgress);
      } else {
        await api('/content', { method: 'POST', body: { title: form.title, description: form.description, url: form.url } });
      }
      setDone(true);
      onChanged?.();
    } catch (err) {
      setError(err.message);
      toast(err.message, 'error');
    } finally {
      setProgress(null);
    }
  }

  function reset() {
    setDone(false); setFile(null); setForm({ title: '', description: '', url: '', target: 'auto' });
  }

  if (done) {
    return (
      <div className="mx-auto max-w-lg">
        <div className="card p-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><CheckCircle2 className="h-7 w-7" /></div>
          <h2 className="text-lg font-semibold text-slate-900">Submitted for review</h2>
          <div className="mt-6 flex justify-center gap-2">
            <Button variant="secondary" onClick={() => navigate('mine')}>My submissions</Button>
            <Button icon={UploadCloud} onClick={reset}>Submit another</Button>
          </div>
        </div>
      </div>
    );
  }

  const destinations = storage ? [storage.local, ...storage.nodes].filter(node => node?.connected) : [];

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Contribute" />

      <form onSubmit={submit} className="card overflow-hidden">
        <div className="flex border-b border-slate-200">
          {[['file', FileUp, 'Upload a file'], ['link', Link2, 'Share a link']].map(([key, Icon, label]) => (
            <button key={key} type="button" onClick={() => { setMode(key); setError(''); }}
              className={cx('flex flex-1 items-center justify-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition',
                mode === key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>

        <div className="space-y-5 p-6">
          {mode === 'file' ? (
            file ? (
              <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                {(() => { const Icon = TYPE_META[fileType].icon; return <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-white text-slate-600 ring-1 ring-slate-200"><Icon className="h-5 w-5" /></div>; })()}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">{file.name}</p>
                  <p className="text-xs text-slate-500">{TYPE_META[fileType].label} · {formatBytes(file.size)}</p>
                  {progress !== null && (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
                      <div className="h-full rounded-full bg-voice transition-all" style={{ width: `${progress}%` }} />
                    </div>
                  )}
                </div>
                {progress === null && (
                  <button type="button" onClick={() => setFile(null)} className="rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600" aria-label="Remove file">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            ) : (
              <div
                role="button" tabIndex={0}
                onClick={() => inputRef.current?.click()}
                onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files[0]); }}
                className={cx('flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition',
                  dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-300 hover:border-slate-400 hover:bg-slate-50')}>
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600"><UploadCloud className="h-6 w-6" /></div>
                <p className="text-sm font-medium text-slate-900">Drop a file here, or <span className="text-brand-700">browse</span></p>
                <p className="mt-1 text-xs text-slate-500">Up to {config?.maxUploadMB || 100} MB</p>
                <input ref={inputRef} type="file" className="hidden" onChange={e => pick(e.target.files[0])} />
              </div>
            )
          ) : (
            <div>
              <label className="label" htmlFor="url">Link URL</label>
              <input id="url" type="url" required className="input" placeholder="https://" value={form.url}
                onChange={e => setForm({ ...form, url: e.target.value })} pattern="https://.*" title="Links must start with https://" />
            </div>
          )}

          <div>
            <label className="label" htmlFor="title">Title</label>
            <input id="title" required maxLength={160} className="input" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} />
          </div>
          <div>
            <div className="flex justify-between"><label className="label" htmlFor="description">Description</label><span className="text-xs text-slate-400">{form.description.length}/2000</span></div>
            <textarea id="description" rows={4} maxLength={2000} className="input resize-y"
              value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
          </div>

          {isAdmin && mode === 'file' && (
            <div>
              <label className="label" htmlFor="target">Storage destination</label>
              <select id="target" className="input" value={form.target} onChange={e => setForm({ ...form, target: e.target.value })}>
                <option value="auto">Automatic</option>
                {destinations.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}
              </select>
            </div>
          )}

          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-6 py-4">
          <Button variant="secondary" onClick={() => navigate('library')}>Cancel</Button>
          <Button type="submit" icon={UploadCloud} loading={progress !== null}>
            {progress !== null ? `Uploading ${progress}%` : 'Submit for review'}
          </Button>
        </div>
      </form>
    </div>
  );
}
