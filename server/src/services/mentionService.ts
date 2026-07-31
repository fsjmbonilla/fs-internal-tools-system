export interface ChannelMemberRef {
  userId: number;
  displayName: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseMentions(
  body: string,
  members: ChannelMemberRef[],
  authorUserId: number,
): number[] {
  // Sort members by display name length (longest first) to prioritize longer matches
  const sorted = members
    .filter(m => m.userId !== authorUserId)
    .sort((a, b) => b.displayName.length - a.displayName.length);

  const matched = new Set<number>();
  const matchedPositions = new Map<number, string>(); // position -> displayName

  // Check each member, longest display names first
  for (const member of sorted) {
    const escaped = escapeRegExp(member.displayName);
    const pattern = new RegExp(`@${escaped}(?!\\w)`, 'gi');

    for (const match of body.matchAll(pattern)) {
      const matchPos = match.index;
      // Only add if this @ position hasn't been claimed by a longer match
      if (!matchedPositions.has(matchPos)) {
        matched.add(member.userId);
        matchedPositions.set(matchPos, member.displayName);
      }
    }
  }

  return [...matched];
}
