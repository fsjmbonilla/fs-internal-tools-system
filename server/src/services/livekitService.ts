import { AccessToken } from 'livekit-server-sdk';
import { config } from '../config.js';

export function isLiveKitConfigured(): boolean {
  return Boolean(config.LIVEKIT_URL && config.LIVEKIT_API_KEY && config.LIVEKIT_API_SECRET);
}

export async function mintCallToken(roomName: string, identity: string, name: string): Promise<string> {
  const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, { identity, name });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  return at.toJwt();
}
