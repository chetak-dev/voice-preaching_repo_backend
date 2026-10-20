import React, { useState } from 'react';
import {
  AlertTriangle, CheckCircle2, CloudCog, HardDrive, Pause, Play, Plug, Plus, RefreshCw, Server, Trash2,
} from 'lucide-react';
import { api } from '../api.js';
import { Badge, Button, ErrorBanner, Modal, PageHeader, Spinner, TYPE_META, cx, formatBytes, useAsync, useToast } from '../components/ui.jsx';

const FILE_TYPES = ['image', 'video', 'audio', 'doc'];
const folderIdFrom = value => value.trim().match(/folders\/([A-Za-z0-9_-]+)/)?.[1] || value.trim();

function QuotaBar({ usage, limit }) {
  if (limit == null) return <p className="text-xs text-slate-500">{usage == null ? 'Quota not checked yet — run a connection test.' : 'Unlimited / pooled storage'}</p>;
  const percent = Math.min(100, Math.round((usage / limit) * 100));
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-slate-500"><span>{formatBytes(usage)} of {formatBytes(limit)}</span><span>{percent}%</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className={cx('h-full rounded-full', percent > 90 ? 'bg-rose-500' : percent > 75 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export default function Storage() {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api('/storage'), []);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', folderId: '', kind: 'oauth', types: [...FILE_TYPES] });
  const [busy, setBusy] = useState(null);

  async function run(id, action, success) {
    setBusy(id);
    try { const result = await action(); toast(result?.message || success); await reload(); return true; } catch (err) { toast(err.message, 'error'); return false; } finally { setBusy(null); }
  }

  async function add() {
    const ok = await run('add', () => api('/storage', { method: 'POST', body: { ...form, folderId: folderIdFrom(form.folderId) } }), 'Storage destination added.');
    if (ok) setAdding(false);
  }

  const toggleType = type => setForm(current => ({
    ...current, types: current.types.includes(type) ? current.types.filter(t => t !== type) : [...current.types, type],
  }));

  return (
    <div>
      <PageHeader title="Storage" description="Connect multiple Google Drives. New uploads are routed automatically to the connected Drive with the most free space."
        actions={<Button icon={Plus} onClick={() => { setForm({ name: '', folderId: '', kind: 'oauth', types: [...FILE_TYPES] }); setAdding(true); }}>Add Google Drive</Button>} />
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && (
        <>
          {!data.oauthReady && !data.serviceReady && (
            <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>Google Drive is not configured on the server yet. Set <code className="font-mono text-xs">GOOGLE_CLIENT_ID</code>, <code className="font-mono text-xs">GOOGLE_CLIENT_SECRET</code> and <code className="font-mono text-xs">STORAGE_ENCRYPTION_KEY</code> (personal Drives) or <code className="font-mono text-xs">GOOGLE_APPLICATION_CREDENTIALS</code> (Shared Drives). Until then, files are kept in local server storage.</p>
            </div>
          )}

          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {data.nodes.map(node => (
              <div key={node.id} className={cx('card flex flex-col p-5', !node.enabled && 'opacity-75')}>
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><HardDrive className="h-5 w-5" /></div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold text-slate-900">{node.name}</h3>
                    <p className="truncate text-xs text-slate-500">{node.accountEmail || (node.kind === 'service' ? 'Service account · Shared Drive' : 'Not connected')}</p>
                  </div>
                  {!node.connected ? <Badge tone="bg-amber-50 text-amber-800 ring-amber-600/20">Needs connection</Badge>
                    : node.enabled ? <Badge tone="bg-emerald-50 text-emerald-700 ring-emerald-600/20" icon={CheckCircle2}>Active</Badge>
                      : <Badge tone="bg-slate-100 text-slate-600 ring-slate-500/20" icon={Pause}>Paused</Badge>}
                </div>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {node.types.map(type => <Badge key={type} tone={TYPE_META[type].tone} icon={TYPE_META[type].icon}>{TYPE_META[type].plural}</Badge>)}
                </div>
                <div className="mt-4"><QuotaBar usage={node.quotaUsage} limit={node.quotaLimit} /></div>
                <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
                  <div><dt className="text-slate-500">Files stored</dt><dd className="font-medium text-slate-800">{node.fileCount}</dd></div>
                  <div className="min-w-0"><dt className="text-slate-500">Folder ID</dt><dd className="truncate font-mono text-slate-800" title={node.folderId}>{node.folderId}</dd></div>
                </dl>
                <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                  {node.kind === 'oauth' && (
                    <Button href={`/api/storage/${node.id}/connect`} size="sm" variant={node.connected ? 'secondary' : 'primary'} icon={Plug}
                      disabled={!data.oauthReady} title={data.oauthReady ? undefined : 'Google OAuth or STORAGE_ENCRYPTION_KEY is not configured'}>
                      {node.connected ? 'Reconnect' : 'Connect'}
                    </Button>
                  )}
                  {node.connected && (
                    <Button size="sm" variant="secondary" icon={RefreshCw} loading={busy === `test-${node.id}`}
                      onClick={() => run(`test-${node.id}`, () => api(`/storage/${node.id}/test`, { method: 'POST' }))}>Test</Button>
                  )}
                  <Button size="sm" variant="secondary" icon={node.enabled ? Pause : Play} loading={busy === `toggle-${node.id}`}
                    onClick={() => run(`toggle-${node.id}`, () => api(`/storage/${node.id}`, { method: 'PATCH', body: { enabled: !node.enabled } }), node.enabled ? 'Drive paused for new uploads.' : 'Drive resumed.')}>
                    {node.enabled ? 'Pause' : 'Resume'}
                  </Button>
                  {node.fileCount === 0 && (
                    <Button size="sm" variant="ghost" icon={Trash2} className="ml-auto text-rose-600 hover:bg-rose-50" aria-label="Remove"
                      onClick={() => window.confirm(`Remove "${node.name}"?`) && run(`del-${node.id}`, () => api(`/storage/${node.id}`, { method: 'DELETE' }), 'Storage destination removed.')} />
                  )}
                </div>
              </div>
            ))}

            <div className="card flex flex-col p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-600"><Server className="h-5 w-5" /></div>
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-slate-900">{data.local.name}</h3>
                  <p className="text-xs text-slate-500">Fallback when no Drive accepts a file type</p>
                </div>
                <Badge tone="bg-slate-100 text-slate-600 ring-slate-500/20">Fallback</Badge>
              </div>
              <p className="mt-4 text-xs text-slate-500">Files stored on the server's disk: <span className="font-medium text-slate-800">{data.local.fileCount}</span></p>
            </div>

            <button type="button" onClick={() => setAdding(true)}
              className="flex min-h-[200px] flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 p-5 text-sm font-medium text-slate-500 transition hover:border-brand-400 hover:bg-brand-50/40 hover:text-brand-700">
              <Plus className="mb-2 h-6 w-6" /> Add another Google Drive
            </button>
          </div>

          <section className="card mt-8 p-6">
            <div className="flex items-center gap-2"><CloudCog className="h-5 w-5 text-brand-600" /><h2 className="text-sm font-semibold text-slate-900">How multi-Drive storage works</h2></div>
            <ol className="mt-4 grid gap-4 text-sm text-slate-600 md:grid-cols-3">
              <li><span className="font-medium text-slate-900">1. Add each Drive.</span> Create a folder in each Google account, paste its folder link here, and choose which file types it should hold.</li>
              <li><span className="font-medium text-slate-900">2. Connect.</span> Personal Drives connect with Google sign-in (a refresh token is stored encrypted). Workspace Shared Drives use a service account.</li>
              <li><span className="font-medium text-slate-900">3. Automatic routing.</span> Each upload goes to the active Drive that accepts its type and has the most free space. Pause a Drive when it is nearly full; its files stay available.</li>
            </ol>
          </section>
        </>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} title="Add Google Drive" description="Register a Drive folder as a storage destination."
        footer={(
          <>
            <Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button loading={busy === 'add'} disabled={!form.name.trim() || !form.folderId.trim() || !form.types.length} onClick={add}>Add Drive</Button>
          </>
        )}>
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="drive-name">Display name</label>
            <input id="drive-name" className="input" maxLength={100} placeholder="e.g. Media Drive 1" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="drive-folder">Folder link or ID</label>
            <input id="drive-folder" className="input font-mono" placeholder="https://drive.google.com/drive/folders/…" value={form.folderId} onChange={e => setForm({ ...form, folderId: e.target.value })} />
          </div>
          <div>
            <span className="label">Connection type</span>
            <div className="grid gap-2 sm:grid-cols-2">
              {[['oauth', 'Personal Google account', 'Sign in with the account that owns the folder.', data?.oauthReady],
                ['service', 'Workspace Shared Drive', 'Uses the server service account.', data?.serviceReady]].map(([kind, title, hint, ready]) => (
                <label key={kind} className={cx('cursor-pointer rounded-lg border p-3 text-sm transition',
                  form.kind === kind ? 'border-brand-500 bg-brand-50/50 ring-1 ring-brand-500' : 'border-slate-200 hover:bg-slate-50')}>
                  <input type="radio" name="kind" className="sr-only" checked={form.kind === kind} onChange={() => setForm({ ...form, kind })} />
                  <span className="block font-medium text-slate-900">{title}</span>
                  <span className="block text-xs text-slate-500">{hint}</span>
                  {!ready && <span className="mt-1 block text-xs text-amber-700">Not configured on server</span>}
                </label>
              ))}
            </div>
          </div>
          <div>
            <span className="label">Accepted file types</span>
            <div className="flex flex-wrap gap-2">
              {FILE_TYPES.map(type => (
                <label key={type} className={cx('flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm',
                  form.types.includes(type) ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-600')}>
                  <input type="checkbox" className="accent-brand-600" checked={form.types.includes(type)} onChange={() => toggleType(type)} />
                  {TYPE_META[type].plural}
                </label>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
