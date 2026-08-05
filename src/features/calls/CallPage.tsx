import '@livekit/components-styles';
import { LiveKitRoom, VideoConference } from '@livekit/components-react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { endCall } from './api';

interface CallLocationState {
  token: string;
  serverUrl: string;
  callId: number;
  channelId: number | null;
}

export function CallPage() {
  const { roomName } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as CallLocationState | null;

  if (!state || !roomName) {
    return (
      <div className="flex h-dvh items-center justify-center text-muted-foreground">
        No active call session — start the call again from the channel.
      </div>
    );
  }

  // Destructure here (rather than referencing `state` inside the closure below):
  // TS control-flow narrowing from the guard above doesn't cross into nested
  // function bodies, so `state` would still type as possibly-null there.
  const { token, serverUrl, callId, channelId } = state;

  async function handleDisconnected() {
    await endCall(callId).catch(() => {});
    navigate(channelId ? `/chat/${channelId}` : '/chat');
  }

  return (
    <LiveKitRoom
      token={token}
      serverUrl={serverUrl}
      connect
      video
      audio
      onDisconnected={handleDisconnected}
      className="h-dvh"
    >
      <VideoConference />
    </LiveKitRoom>
  );
}
