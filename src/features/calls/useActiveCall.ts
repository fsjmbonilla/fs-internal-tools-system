import { useEffect, useState } from 'react';
import { onCallEnded, onCallStarted } from '@/lib/socket';
import { getActiveCall } from './api';
import type { Call } from './types';

export function useActiveCall(channelId: number): Call | null {
  const [call, setCall] = useState<Call | null>(null);

  useEffect(() => {
    let cancelled = false;
    getActiveCall(channelId).then((res) => {
      if (!cancelled) setCall(res.call);
    });

    const offStarted = onCallStarted((e) => {
      if (e.channelId !== channelId) return;
      setCall((current) =>
        current ?? {
          id: e.callId,
          channelId,
          roomName: e.roomName,
          startedBy: 0,
          startedAt: new Date().toISOString(),
          endedAt: null,
        },
      );
    });
    const offEnded = onCallEnded((e) => {
      if (e.channelId !== channelId) return;
      setCall((current) => (current?.id === e.callId ? null : current));
    });

    return () => {
      cancelled = true;
      offStarted();
      offEnded();
    };
  }, [channelId]);

  return call;
}
