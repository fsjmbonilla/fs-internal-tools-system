import { useState } from 'react';
import { useNavigate } from 'react-router';
import { startCall } from './api';
import { ApiError } from '@/lib/api';
import type { Call } from './types';

export function CallBanner({ channelId, activeCall }: { channelId: number; activeCall: Call | null }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    try {
      const res = await startCall(channelId);
      navigate(`/call/${res.call.roomName}`, {
        state: { token: res.token, serverUrl: res.serverUrl, callId: res.call.id, channelId },
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to start call');
      }
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        className="flex w-full items-center justify-center gap-2 border-b bg-accent px-4 py-2 text-sm font-medium hover:bg-accent/80"
      >
        {activeCall ? 'Join call' : 'Start call'}
      </button>
      {error && <div className="px-4 py-2 text-xs text-red-600">{error}</div>}
    </div>
  );
}
