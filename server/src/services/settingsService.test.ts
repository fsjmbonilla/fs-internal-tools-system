import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../db/testUtils.js';
import { getAllowedDomains, isEmailAllowed, setAllowedDomains } from './settingsService.js';

describe('settingsService', () => {
  beforeEach(resetDb);

  it('returns defaults when unset', async () => {
    expect(await getAllowedDomains()).toEqual(['flowerstore.ph', 'potico.ph', 'potico.co.th']);
  });

  it('persists updates and checks emails case-insensitively', async () => {
    await setAllowedDomains(['example.com'], 1);
    expect(await getAllowedDomains()).toEqual(['example.com']);
    expect(await isEmailAllowed('Person@Example.COM')).toBe(true);
    expect(await isEmailAllowed('person@flowerstore.ph')).toBe(false);
    expect(await isEmailAllowed('person@evil-example.com')).toBe(false);
    expect(await isEmailAllowed('no-at-sign')).toBe(false);
  });
});
