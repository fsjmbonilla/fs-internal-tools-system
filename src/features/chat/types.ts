export interface Channel {
  id: number;
  name: string | null;
  type: 'public' | 'private' | 'dm';
  isPrivate: boolean;
  topic: string | null;
  departmentId: number | null;
  unreadCount: number;
}

export interface Reaction {
  emoji: string;
  userIds: number[];
}

export interface Message {
  id: number;
  channelId: number;
  userId: number;
  displayName: string;
  body: string;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  reactions: Reaction[];
}
