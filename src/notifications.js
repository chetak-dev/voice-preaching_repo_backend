import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

const POLL_MS = 60000;
const EMPTY = { items: [], unread: 0, pendingReview: 0 };

// Loads in-app notifications every minute and whenever the app comes back into focus.
export function useNotifications(userId) {
  const [state, setState] = useState(EMPTY);
  const refresh = useCallback(() => api('/notifications').then(setState).catch(() => {}), []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
    const onFocus = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh, userId]);

  const markRead = useCallback(async ids => {
    const now = new Date().toISOString();
    setState(current => {
      const items = current.items.map(item => (!item.read_at && (!ids || ids.includes(item.id)) ? { ...item, read_at: now } : item));
      return { ...current, items, unread: ids ? Math.max(0, current.unread - current.items.filter(item => !item.read_at && ids.includes(item.id)).length) : 0 };
    });
    await api('/notifications/read', { method: 'POST', body: ids ? { ids } : {} }).catch(() => {});
  }, []);

  return { ...state, refresh, markRead };
}
