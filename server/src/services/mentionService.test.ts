import { describe, expect, it } from 'vitest';
import { parseMentions } from './mentionService.js';

describe('parseMentions', () => {
  const members = [
    { userId: 1, displayName: 'jane' },
    { userId: 2, displayName: 'Jane Doe' },
    { userId: 3, displayName: 'bob' },
  ];

  it('matches a plain @displayName mention, case-insensitively', () => {
    expect(parseMentions('hey @Jane can you look at this', members, 3)).toEqual([1]);
  });

  it('matches a multi-word display name', () => {
    expect(parseMentions('cc @Jane Doe', members, 3)).toEqual([2]);
  });

  it('never includes the author even if they mention themselves', () => {
    expect(parseMentions('note to self @bob', members, 3)).toEqual([]);
  });

  it('does not match a longer name that merely starts with the mention text', () => {
    expect(parseMentions('@Janet is not jane', members, 3)).toEqual([]);
  });

  it('dedupes when the same person is mentioned twice', () => {
    expect(parseMentions('@bob @bob', members, 1)).toEqual([3]);
  });

  it('returns no matches for plain text with no @ at all', () => {
    expect(parseMentions('no mentions here', members, 3)).toEqual([]);
  });
});
