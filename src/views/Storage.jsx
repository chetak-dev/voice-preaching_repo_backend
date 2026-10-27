import React, { useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Circle, HardDrive, Pause, Play, Plug, Plus, RefreshCw, Server, Trash2,
} from 'lucide-react';
import { api } from '../api.js';
import { Badge, Button, ErrorBanner, Modal, PageHeader, Spinner, cx, formatBytes, useAsync, useToast } from '../components/ui.jsx';

const folderIdFrom = value => value.trim().match(/folders\/([A-Za-z0-9_-]+)/)?.[1] || value.trim();
const EMPTY_FORM = { name: '', folderId: '', kind: 'oauth' };

function SetupItem({ done, children }) {
  return (
    <li className="flex items-start gap-2.5">
      {done ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />}
      <span className={done ? 'text-slate-500' : 'text-slate-800'}>{children}</span>
    </li>
  );
}

function SetupChecklist({ setup }) {
  const code = 'rounded bg-white/80 px-1 py-0.5 font-mono text-[11px] ring-1 ring-slate-200';
  return (
    <section className="card mb-6 overflow-hidden">
      <div className="flex items-center gap-3 border-b border-amber-100 bg-gradient-to-r from-amber-50 to-orange-50 px-5 py-3.5">
        <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Finish Google Drive setup in <code className={code}>.env</code></h2>
        </div>
      </div>
      <div className="grid gap-6 p-5 text-sm md:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Personal Google Drives</p>
          <ul className="space-y-2">
            <SetupItem done={setup.googleClient}>OAuth client: <code className={code}>GOOGLE_CLIENT_ID</code> and <code className={code}>GOOGLE_CLIENT_SECRET</code></SetupItem>
            <SetupItem done={setup.encryptionKey}><code className={code}>STORAGE_ENCRYPTION_KEY</code> (64 hex characters)</SetupItem>
            <SetupItem done={setup.googleClient}>Redirect URI in Google Cloud: <code className={cx(code, 'break-all')}>{setup.redirectUri}</code></SetupItem>
          </ul>
        </div>
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Workspace Shared Drives (optional)</p>
          <ul className="space-y-2">
            <SetupItem done={setup.serviceAccount}>Service account key: <code className={code}>GOOGLE_APPLICATION_CREDENTIALS</code></SetupItem>
            <SetupItem done={setup.serviceAccount}>Add the service account email as a member of the Shared Drive</SetupItem>
          </ul>
        </div>
      </div>
    </section>
  );
}

function QuotaBar({ usage, limit }) {
  if (limit == null) return <p className="text-xs text-slate-500">{usage == null ? 'Quota not checked' : 'Unlimited'}</p>;
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
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(null);

  async function run(id, action, success) {
    setBusy(id);
    try { const result = await action(); toast(result?.message || success); await reload(); return true; } catch (err) { toast(err.message, 'error'); return false; } finally { setBusy(null); }
  }

  async function add() {
    const body = form.kind === 'service' ? { ...form, folderId: folderIdFrom(form.folderId) } : { name: form.name, kind: form.kind };
    const ok = await run('add', () => api('/storage', { method: 'POST', body }), 'Drive added. Click Connect to finish.');
    if (ok) setAdding(false);
  }

  const openAdd = () => { setForm(EMPTY_FORM); setAdding(true); };

  return (
    <div>
      <PageHeader title="Storage"
        actions={<Button icon={Plus} onClick={openAdd}>Add Google Drive</Button>} />
      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && (
        <>
          {!data.oauthReady && data.setup && <SetupChecklist setup={data.setup} />}

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
                <div className="mt-4"><QuotaBar usage={node.quotaUsage} limit={node.quotaLimit} /></div>
                <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
                  <div><dt className="text-slate-500">Files stored</dt><dd className="font-medium text-slate-800">{node.fileCount}</dd></div>
                  <div className="min-w-0">
                    <dt className="text-slate-500">Folder</dt>
                    <dd className="truncate font-medium text-slate-800">
                      {node.folderId
                        ? <a className="text-brand-700 hover:underline" href={`https://drive.google.com/drive/folders/${node.folderId}`} target="_blank" rel="noreferrer">{node.kind === 'oauth' ? 'App folder' : 'Open folder'}</a>
                        : <span className="text-slate-400">Created on connect</span>}
                    </dd>
                  </div>
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

            {data.local && (
              <div className="card flex flex-col p-5">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-600"><Server className="h-5 w-5" /></div>
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-slate-900">{data.local.name}</h3>
                  </div>
                  <Badge tone="bg-slate-100 text-slate-600 ring-slate-500/20">Fallback</Badge>
                </div>
                <dl className="mt-4 text-xs"><dt className="text-slate-500">Files stored</dt><dd className="font-medium text-slate-800">{data.local.fileCount}</dd></dl>
              </div>
            )}

            <button type="button" onClick={openAdd}
              className="flex min-h-[200px] flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 p-5 text-sm font-medium text-slate-500 transition hover:border-brand-400 hover:bg-brand-50/40 hover:text-brand-700">
              <Plus className="mb-2 h-6 w-6" /> Add Google Drive
            </button>
          </div>
        </>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} size="lg" title="Add Google Drive"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button icon={Plus} loading={busy === 'add'} disabled={!form.name.trim() || (form.kind === 'service' && !form.folderId.trim())} onClick={add}>Add Drive</Button>
          </>
        )}>
        <div className="space-y-5">
          <div>
            <label className="label" htmlFor="drive-name">Display name</label>
            <input id="drive-name" className="input" maxLength={100} autoFocus placeholder="e.g. Media Drive 1" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <span className="label">Connection type</span>
            <div className="grid gap-3 sm:grid-cols-2">
              {[['oauth', 'Personal Google account', data?.oauthReady],
                ['service', 'Workspace Shared Drive', data?.serviceReady]].map(([kind, title, ready]) => (
                <label key={kind} className={cx('flex cursor-pointer gap-3 rounded-xl border p-4 text-sm transition',
                  form.kind === kind ? 'border-brand-500 bg-brand-50/60 ring-1 ring-brand-500' : 'border-slate-200 hover:bg-slate-50')}>
                  <input type="radio" name="kind" className="mt-0.5 accent-brand-600" checked={form.kind === kind} onChange={() => setForm({ ...form, kind })} />
                  <span className="min-w-0">
                    <span className="block font-semibold text-slate-900">{title}</span>
                    <span className={cx('mt-2 inline-flex items-center gap-1 text-xs font-medium', ready ? 'text-emerald-700' : 'text-amber-700')}>
                      {ready ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                      {ready ? 'Ready' : 'Setup pending'}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          {form.kind === 'oauth' ? (
            <p className="rounded-xl bg-brand-50/70 px-4 py-3 text-sm text-slate-600 ring-1 ring-inset ring-brand-100">
              After adding, click <strong className="text-slate-800">Connect</strong> and sign in with the Google account for this Drive.
              Kalpa Taru creates a <strong className="text-slate-800">Kalpa Taru Media</strong> folder there and can only access the files it uploads.
            </p>
          ) : (
            <div>
              <label className="label" htmlFor="drive-folder">Shared Drive folder link or ID</label>
              <input id="drive-folder" className="input font-mono text-xs" placeholder="https://drive.google.com/drive/folders/…" value={form.folderId} onChange={e => setForm({ ...form, folderId: e.target.value })} />
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
