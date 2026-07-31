export interface Call {
  id: number;
  channelId: number | null;
  roomName: string;
  startedBy: number;
  startedAt: string;
  endedAt: string | null;
}

export interface StartCallResponse {
  call: Call;
  token: string;
  serverUrl: string;
}
