import { describe, expect, it } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  totp,
  verifyTotp,
  hashPassword,
  verifyPassword,
} from '../src/modules/admin/crypto.js';
import { validateAdminConfig, loadAdminConfig } from '../src/modules/admin/config.js';
describe('admin cryptographic boundaries', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  it('matches RFC 6238 SHA1 and rejects accepted counters', () => {
    expect(totp(secret, 1, 8)).toBe('94287082');
    expect(totp(secret, 1)).toBe('287082');
    expect(verifyTotp(secret, '287082', 59000, null)).toBe(1n);
    expect(verifyTotp(secret, '287082', 59000, 1n)).toBeNull();
    expect(verifyTotp(secret, '28708a', 59000, null)).toBeNull();
  });
  it('binds encryption to account and rejects tampering', () => {
    const key = Buffer.alloc(32, 11).toString('base64');
    const value = encryptSecret(secret, key, 'account-a');
    expect(decryptSecret(value, key, 'account-a')).toBe(secret);
    expect(encryptSecret(secret, key, 'account-a')).not.toBe(value);
    expect(() => decryptSecret(value, key, 'account-b')).toThrow();
    expect(() => decryptSecret(`${value.slice(0, -2)}aa`, key, 'account-a')).toThrow();
    expect(() => encryptSecret(secret, 'short', 'a')).toThrow();
  });
  it('uses salted password hashes and rejects malformed hashes', async () => {
    const hash = await hashPassword('test-only-long-password');
    expect(await verifyPassword('test-only-long-password', hash)).toBe(true);
    expect(await verifyPassword('different-long-password', hash)).toBe(false);
    expect(await verifyPassword('test-only-long-password', 'bad')).toBe(false);
    expect(await hashPassword('test-only-long-password')).not.toBe(hash);
  });
  it('matches additional RFC vectors and only accepts the configured drift window', () => {
    for (const [seconds, want] of [
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ] as const)
      expect(totp(secret, Math.floor(seconds / 30), 8)).toBe(want);
    expect(verifyTotp(secret, '287082', 89000, null)).toBe(1n);
    expect(verifyTotp(secret, '287082', 119000, null)).toBeNull();
  });
  it('defaults off, enforces exact origins/key, and refuses production activation without leaking key values', () => {
    expect(loadAdminConfig({}).enabled).toBe(false);
    const key = Buffer.alloc(32, 7).toString('base64');
    for (const origins of [[], ['*'], ['http://evil.example'], ['https://example.test/path']])
      expect(() =>
        validateAdminConfig({ enabled: true, origins, encryptionKey: key }, 'test'),
      ).toThrow();
    expect(() =>
      validateAdminConfig(
        { enabled: true, origins: ['http://localhost:3010'], encryptionKey: key },
        'production',
      ),
    ).toThrow(/production/);
    expect(() =>
      validateAdminConfig(
        { enabled: true, origins: ['http://localhost:3010'], encryptionKey: 'private-bad-key' },
        'test',
      ),
    ).toThrow('Invalid admin encryption key');
  });
});
