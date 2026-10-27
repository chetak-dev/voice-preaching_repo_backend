import React from 'react';
import { CheckCircle2, Download, Loader2 } from 'lucide-react';
import { canDownload, cancelDownload, downloadForOffline, removeDownload, useDownloadState } from '../offline.js';
import { Button, cx, useToast } from './ui.jsx';

// Save / progress / remove control for offline listening. Renders nothing for items that can't be downloaded.
export default function DownloadButton({ item, className }) {
  const toast = useToast();
  const { status, progress } = useDownloadState(item?.id);
  if (!canDownload(item)) return null;

  if (status === 'downloading') {
    const percent = Math.round((progress || 0) * 100);
    return (
      <Button variant="secondary" size="sm" className={cx('tabular-nums', className)} onClick={() => cancelDownload(item.id)}
        title="Cancel download" aria-label={`Downloading ${percent}%. Tap to cancel.`}>
        <Loader2 className="h-4 w-4 animate-spin text-brand-600" />{percent}%
      </Button>
    );
  }

  if (status === 'downloaded') {
    const remove = async () => {
      if (!window.confirm(`Remove "${item.title}" from this device?`)) return;
      try { await removeDownload(item.id); toast('Removed from downloads.', 'info'); } catch (error) { toast(error.message, 'error'); }
    };
    return (
      <Button variant="secondary" size="sm" icon={CheckCircle2} onClick={remove} title="Downloaded — tap to remove from this device"
        className={cx('text-emerald-700 [&>svg]:text-emerald-600', className)}>
        Downloaded
      </Button>
    );
  }

  const start = async () => {
    try {
      await downloadForOffline(item);
      toast('Downloaded. You can now play it without internet.');
    } catch (error) {
      if (error?.name !== 'AbortError') toast(error.message, 'error');
    }
  };
  return (
    <Button variant="secondary" size="sm" icon={Download} onClick={start} title="Download for offline listening" className={className}>
      Download
    </Button>
  );
}
