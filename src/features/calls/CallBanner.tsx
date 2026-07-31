import { useNavigate } from 'react-router';
import { startCall } from './api';
import type { Call } from './types';

export function CallBanner({ channelId, activeCall }: { channelId: number; activeCall: Call | null }) {
  const navigate = useNavigate();

  async function handleClick() {
    const res = await startCall(channelId);
    navigate(`/call/${res.call.roomName}`, {
      state: { token: res.token, serverUrl: res.serverUrl, callId: res.call.id, channelId },
    });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex w-full items-center justify-center gap-2 border-b bg-accent px-4 py-2 text-sm font-medium hover:bg-accent/80"
    >
      {activeCall ? 'Join call' : 'Start call'}
    </button>
  );
}
