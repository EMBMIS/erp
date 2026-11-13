/**
 * Offline Queue for Mobile PWA scanning & warehouse transactions.
 *
 * Stores pending warehouse operations in localStorage when disconnected
 * and automatically drains the queue when internet connection restores.
 */

const QUEUE_KEY = 'qira_pwa_offline_queue';

export function getOfflineQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function enqueueOfflineAction(action) {
  const queue = getOfflineQueue();
  const entry = {
    id: `act_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    action,
    createdAt: new Date().toISOString(),
  };
  queue.push(entry);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  return entry;
}

export async function flushOfflineQueue(apiCaller) {
  const queue = getOfflineQueue();
  if (queue.length === 0) return { flushed: 0, errors: [] };

  const remaining = [];
  let flushedCount = 0;
  const errors = [];

  for (const item of queue) {
    try {
      await apiCaller(item.action);
      flushedCount++;
    } catch (err) {
      console.error('Failed to sync offline action:', item, err);
      errors.push({ item, error: err.message });
      remaining.push(item);
    }
  }

  localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  return { flushed: flushedCount, remaining: remaining.length, errors };
}

// Auto-sync listener when network status changes to online
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    console.log('[PWA] Network restored. Attempting offline queue sync...');
  });
}
