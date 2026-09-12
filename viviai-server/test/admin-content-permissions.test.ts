import { describe, expect, it } from 'vitest';
import {
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
  validPermissionSet,
} from '../src/modules/admin/permission-catalog.js';

const families = ['inspirations', 'templates', 'tools'] as const;

describe('admin content permissions', () => {
  it('defines exact read, write and publish dependencies', () => {
    for (const family of families) {
      expect(
        PERMISSION_CATALOG.find((p) => p.key === `content.${family}.read`)?.dependencies,
      ).toEqual([]);
      expect(
        PERMISSION_CATALOG.find((p) => p.key === `content.${family}.write`)?.dependencies,
      ).toEqual([`content.${family}.read`]);
      expect(
        PERMISSION_CATALOG.find((p) => p.key === `content.${family}.publish`)?.dependencies,
      ).toEqual([`content.${family}.read`, `content.${family}.write`]);
    }
    expect(PERMISSION_CATALOG.find((p) => p.key === 'content.media.write')?.dependencies).toEqual([
      'content.media.read',
    ]);
  });

  it('grants super admin and content operator the complete content set only', () => {
    const contentPermissions = [
      ...families.flatMap((family) => [
        `content.${family}.read`,
        `content.${family}.write`,
        `content.${family}.publish`,
      ]),
      'content.media.read',
      'content.media.write',
    ];
    for (const permission of contentPermissions) {
      expect(ROLE_PERMISSIONS.super_admin).toContain(permission);
      expect(ROLE_PERMISSIONS.content_operator).toContain(permission);
    }
    expect(ROLE_PERMISSIONS.content_operator).not.toContain('users.read');
    expect(ROLE_PERMISSIONS.content_operator).not.toContain('jobs.read');
    expect(ROLE_PERMISSIONS.content_operator).not.toContain('audit.read');
    expect(validPermissionSet(['dashboard.read', ...contentPermissions], true)).toBe(true);
    expect(validPermissionSet(['dashboard.read', 'content.tools.publish'], true)).toBe(false);
  });
});
