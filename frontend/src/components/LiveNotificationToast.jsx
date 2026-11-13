import React, { useEffect } from 'react';
import toast from 'react-hot-toast';

export default function LiveNotificationToast() {
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;

    let eventSource;
    try {
      eventSource = new EventSource(`/api/notifications/stream?token=${encodeURIComponent(token)}`);
      
      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type && data.type !== 'CONNECTED') {
            toast.success(`⚡ Live Alert: ${data.payload?.title || data.type}`, {
              duration: 5000,
              icon: '🔔',
            });
          }
        } catch (err) {}
      };

      eventSource.onerror = () => {
        eventSource.close();
      };
    } catch (err) {}

    return () => {
      if (eventSource) eventSource.close();
    };
  }, []);

  return null;
}
