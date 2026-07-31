// Single-process in-memory registry. If the backend ever scales to multiple
// tasks, this needs to move to a shared store (memcached has no pub/sub, so
// plain presence-per-task plus a shared counter, or a dedicated store, would
// be needed then) — not a concern with the current single-task deployment.
const onlineUsers = new Map<number, number>();

export function markOnline(userId: number): void {
  onlineUsers.set(userId, (onlineUsers.get(userId) ?? 0) + 1);
}

export function markOffline(userId: number): void {
  const count = onlineUsers.get(userId);
  if (count === undefined) return;
  if (count <= 1) onlineUsers.delete(userId);
  else onlineUsers.set(userId, count - 1);
}

export function isOnline(userId: number): boolean {
  return onlineUsers.has(userId);
}

export function filterOffline(userIds: number[]): number[] {
  return userIds.filter((id) => !onlineUsers.has(id));
}
