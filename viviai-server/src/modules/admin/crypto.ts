import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function token() {
  return randomBytes(32).toString('base64url');
}
export function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
export function newSecret() {
  const bytes = randomBytes(20);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  return bits
    .match(/.{5}/g)!
    .map((b) => alphabet[parseInt(b, 2)])
    .join('');
}
function decodeSecret(secret: string) {
  if (!/^[A-Z2-7]{32}$/.test(secret)) throw new Error('Invalid MFA secret');
  const bits = [...secret].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
}
export function encryptionKey(value: string) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('Invalid admin encryption key');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value)
    throw new Error('Invalid admin encryption key');
  return key;
}
export function encryptSecret(secret: string, key: string, accountId: string) {
  decodeSecret(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(key), iv);
  cipher.setAAD(Buffer.from(accountId));
  const bytes = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
}
export function decryptSecret(value: string, key: string, accountId: string) {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 60 || bytes.toString('base64') !== value)
    throw new Error('Invalid encrypted MFA secret');
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey(key), bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(accountId));
  cipher.setAuthTag(bytes.subarray(12, 28));
  const secret = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(
    'utf8',
  );
  decodeSecret(secret);
  return secret;
}
export function totp(secret: string, counter: number | bigint, digits = 6) {
  if (![6, 8].includes(digits) || BigInt(counter) < 0n) throw new Error('Invalid TOTP parameters');
  const value = Buffer.alloc(8);
  value.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac('sha1', decodeSecret(secret)).update(value).digest();
  const offset = hash[19]! & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
export function verifyTotp(secret: string, code: string, now: number, last: bigint | null) {
  if (!/^\d{6}$/.test(code)) return null;
  const counter = BigInt(Math.floor(now / 30000));
  for (const step of [0n, -1n, 1n]) {
    const candidate = counter + step;
    if (
      candidate >= 0n &&
      (last === null || candidate > last) &&
      timingSafeEqual(Buffer.from(totp(secret, candidate)), Buffer.from(code))
    )
      return candidate;
  }
  return null;
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
}
export async function hashPassword(password: string, minimumLength: 6 | 12 = 12) {
  // Callers may lower the minimum only after applying the local development policy.
  if (![6, 12].includes(minimumLength) || password.length < minimumLength || password.length > 128)
    throw new Error('Invalid password length');
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await derive(password, salt)).toString('hex')}`;
}
const missingHash = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;
export async function verifyPassword(password: string, hash = missingHash) {
  const valid = /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(hash);
  const parts = (valid ? hash : missingHash).split('$');
  const computed = await derive(password, Buffer.from(parts[1]!, 'hex'));
  return timingSafeEqual(computed, Buffer.from(parts[2]!, 'hex')) && valid;
}
export function recoveryCodes() {
  return Array.from({ length: 8 }, () => randomBytes(16).toString('hex'));
}
