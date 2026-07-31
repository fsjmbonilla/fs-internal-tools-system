import { describe, expect, it } from 'vitest';
import { filterOffline, isOnline, markOffline, markOnline } from './presence.js';

describe('presence', () => {
  it('tracks online state and supports multiple connections per user', () => {
    markOnline(101);
    expect(isOnline(101)).toBe(true);
    markOnline(101); // a second tab/device for the same user
    markOffline(101); // one of the two disconnects
    expect(isOnline(101)).toBe(true); // still online via the other connection
    markOffline(101);
    expect(isOnline(101)).toBe(false);
  });

  it('markOffline on a user with no tracked connections is a no-op', () => {
    expect(() => markOffline(202)).not.toThrow();
    expect(isOnline(202)).toBe(false);
  });

  it('filterOffline keeps only userIds that are not currently online', () => {
    markOnline(301);
    expect(filterOffline([301, 302, 303])).toEqual([302, 303]);
    markOffline(301);
  });
});
