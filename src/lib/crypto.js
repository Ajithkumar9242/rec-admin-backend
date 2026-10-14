import crypto from 'crypto';
import argon2 from 'argon2';
import { env } from '../config/env.js';

/**
 * Hash password using Argon2id
 */
export async function hashPassword(password) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 2 ** 16, // 64 MB
    timeCost: 3,
    parallelism: 1,
  });
}

/**
 * Verify password against Argon2 hash
 */
export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch (error) {
    return false;
  }
}

/**
 * Authenticated Encryption for sensitive MFA/TOTP secrets using AES-256-GCM
 */
export function encryptTotpSecret(plainSecret) {
  if (!plainSecret) return null;
  const key = Buffer.from(env.MFA_ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12); // Standard 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  const encrypted = Buffer.concat([cipher.update(plainSecret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Authenticated Decryption for sensitive MFA/TOTP secrets using AES-256-GCM
 */
export function decryptTotpSecret(ciphertext) {
  if (!ciphertext) return null;
  
  // Format check: iv:tag:data
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    // If not matching encrypted format (e.g. legacy plain secret), return as-is
    return ciphertext;
  }

  const [ivHex, tagHex, dataHex] = parts;
  try {
    const key = Buffer.from(env.MFA_ENCRYPTION_KEY, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (error) {
    throw new Error('Failed to decrypt authenticated MFA secret. Key mismatch or corrupted ciphertext.');
  }
}

/**
 * Generate a cryptographically secure random token (e.g. for password reset)
 */
export function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Hash a token with SHA-256 for secure database storage
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate cryptographically secure single-use backup codes.
 * Returns an array of plain codes formatted like 'XXXX-XXXX'.
 */
export function generateBackupCodes(count = 10) {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // Base32 without lookalikes (0/O, 1/I)
  const codes = [];

  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(8);
    let code = '';
    for (let b = 0; b < 8; b++) {
      code += chars[bytes[b] % chars.length];
      if (b === 3) code += '-';
    }
    codes.push(code);
  }

  return codes;
}

/**
 * Hash a backup code with SHA-256 (normalized to upper case, non-alphanumeric removed)
 */
export function hashBackupCode(code) {
  const normalized = code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Constant-time comparison of two strings
 */
export function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
