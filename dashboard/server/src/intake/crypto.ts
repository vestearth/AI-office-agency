import crypto from 'crypto';

const KEYLEN = 64;

export function hashSecret(secret: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(secret, salt, KEYLEN).toString('hex');
  return { hash, salt };
}

export function verifySecret(secret: string, hash: string, salt: string): boolean {
  const derived = crypto.scryptSync(secret, salt, KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(9).toString('hex')}`;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}
