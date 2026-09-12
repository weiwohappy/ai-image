import { describe, expect, it } from 'vitest';
import {
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
  validPermissionSet,
} from '../src/modules/admin/permission-catalog.js';

describe('admin marketing permissions', () => {
  it('requires redemption read before write and keeps referral reads independent', () => {
    expect(
      PERMISSION_CATALOG.find((item) => item.key === 'redemptions.read')?.dependencies,
    ).toEqual([]);
    expect(
      PERMISSION_CATALOG.find((item) => item.key === 'redemptions.write')?.dependencies,
    ).toEqual(['redemptions.read']);
    expect(PERMISSION_CATALOG.find((item) => item.key === 'referrals.read')?.dependencies).toEqual(
      [],
    );
    expect(
      validPermissionSet(['dashboard.read', 'redemptions.read', 'redemptions.write'], true),
    ).toBe(true);
    expect(validPermissionSet(['dashboard.read', 'redemptions.write'], true)).toBe(false);
  });

  it('grants marketing operations only to the intended built-in roles', () => {
    for (const role of ['super_admin', 'owner']) {
      expect(ROLE_PERMISSIONS[role]).toEqual(
        expect.arrayContaining(['redemptions.read', 'redemptions.write', 'referrals.read']),
      );
    }
    expect(ROLE_PERMISSIONS.content_operator).not.toContain('redemptions.read');
    expect(ROLE_PERMISSIONS.content_operator).not.toContain('redemptions.write');
    expect(ROLE_PERMISSIONS.content_operator).not.toContain('referrals.read');
  });
});
