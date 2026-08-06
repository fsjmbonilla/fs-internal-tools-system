export interface Channel {
  id: number;
  name: string | null;
  type: 'public' | 'private' | 'dm';
  // A support channel is triaged by the assistant: what you type in one may become
  // a ticket. That is worth knowing before you type, so the sidebar marks it.
  kind: 'standard' | 'support';
  isPrivate: boolean;
  topic: string | null;
  departmentId: number | null;
  unreadCount: number;
}

export interface Reaction {
  emoji: string;
  userIds: number[];
}

export interface MessageAttachment {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface Message {
  id: number;
  channelId: number;
  userId: number;
  displayName: string;
  isBot: boolean;
  body: string;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  reactions: Reaction[];
  attachments: MessageAttachment[];
}
