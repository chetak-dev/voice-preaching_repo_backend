import React, { useEffect, useState } from 'react';
import { CloudOff, HardDrive, Play, Trash2 } from 'lucide-react';
import { useMediaPlayer } from '../components/MediaPlayer.jsx';
import { isOfflineSupported, offlineThumbKey, removeDownload, totalDownloadSize, useDownloads, verifyDownloads } from '../offline.js';
import { Button, EmptyState, PageHeader, TYPE_META, cx, formatBytes, useToast } from '../components/ui.jsx';

function Thumb({ item }) {
  const [failed, setFailed] = useState(false);
  const meta = TYPE_META[item.type] || TYPE_META.audio;
  const Icon = meta.icon;
  if (item.has_thumb && !failed) {
    return <img src={offlineThumbKey(item.id)} alt="" loading="lazy" onError={() => setFailed(true)}
      className="h-12 w-12 shrink-0 rounded-xl bg-slate-100 object-cover sm:h-14 sm:w-14" />;
  }
  return (
    <span className={cx('flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-sm sm:h-14 sm:w-14', meta.tile)}>
      <Icon className="h-5 w-5" />
    </span>
  );
}

const savedOn = iso => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

export default function Downloads({ navigate }) {
  const downloads = useDownloads();
  const { openPlayer, currentItem } = useMediaPlayer();
  const toast = useToast();
  const [removing, setRemoving] = useState(null);
  const supported = isOfflineSupported();

  useEffect(() => { if (supported) verifyDownloads().catch(() => {}); }, [supported]);

  const remove = async item => {
    if (!window.confirm(`Remove "${item.title}" from this device?`)) return;
    setRemoving(item.id);
    try { await removeDownload(item.id); toast('Removed from downloads.', 'info'); } catch (error) { toast(error.message, 'error'); } finally { setRemoving(null); }
  };

  return (
    <div>
      <PageHeader title="Downloads" />
      <p className="-mt-2 mb-5 text-sm text-slate-500 lg:-mt-4">Audio and video saved on this device, so you can listen without internet.</p>

      {!supported && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <CloudOff className="h-4 w-4 shrink-0" />
          <span>This browser doesn't support offline downloads. Install the app or use an up-to-date browser.</span>
        </div>
      )}

      {downloads.length === 0 ? (
        <EmptyState icon={CloudOff} title="No downloads yet" action={(
          <div className="flex flex-col items-center gap-4">
            <p className="-mt-3 max-w-xs text-sm text-slate-500">Open an audio or video and tap Download to listen offline.</p>
            {navigate && <Button variant="secondary" onClick={() => navigate('library')}>Browse library</Button>}
          </div>
        )} />
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2 text-sm text-slate-600">
            <HardDrive className="h-4 w-4 text-brand-600" />
            <span>
              <span className="font-semibold text-slate-900">{downloads.length}</span> {downloads.length === 1 ? 'item' : 'items'} ·{' '}
              <span className="font-semibold text-slate-900">{formatBytes(totalDownloadSize(downloads))}</span> used on this device
            </span>
          </div>
          <div className="card divide-y divide-slate-100">
            {downloads.map(item => {
              const playing = currentItem?.id === item.id;
              return (
                <div key={item.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                  <button type="button" onClick={() => openPlayer(item)} className="shrink-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" aria-label={`Play ${item.title}`}>
                    <Thumb item={item} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className={cx('truncate text-sm font-semibold', playing ? 'text-brand-700' : 'text-slate-900')}>{item.title}</p>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      {[item.uploader, formatBytes(item.size), savedOn(item.savedAt) && `Saved ${savedOn(item.savedAt)}`].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <Button size="sm" icon={Play} onClick={() => openPlayer(item)} aria-label={`Play ${item.title}`}>
                    <span className="hidden sm:inline">{playing ? 'Playing' : 'Play'}</span>
                  </Button>
                  <Button variant="ghost" size="sm" icon={Trash2} loading={removing === item.id} onClick={() => remove(item)}
                    aria-label={`Remove ${item.title}`} title="Remove download" className="text-rose-600 hover:bg-rose-50 hover:text-rose-700">
                    <span className="hidden sm:inline">Remove</span>
                  </Button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
