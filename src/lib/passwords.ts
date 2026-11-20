/**
 * Password storage for this offline-first client.
 *
 * PBKDF2 is built into Web Crypto, so no third-party password library or
 * network call is needed. This protects database exports and accidental local
 * inspection; it is not a substitute for server-side authentication.
 */
export const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_HASH_PREFIX = 'pbkdf2-sha256';
const PASSWORD_HASH_ITERATIONS = 210_000;
const PASSWORD_HASH_BYTES = 32;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function getSubtleCrypto(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure password hashing is unavailable. Open the app on HTTPS or in its desktop app.');
  }
  return globalThis.crypto.subtle;
}

export function isPasswordHash(value: string): boolean {
  return value.startsWith(`${PASSWORD_HASH_PREFIX}$`);
}

export async function hashPassword(password: string): Promise<string> {
  const subtle = getSubtleCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PASSWORD_HASH_ITERATIONS, hash: 'SHA-256' },
    key,
    PASSWORD_HASH_BYTES * 8,
  );
  const digest = new Uint8Array(bits);
  return [PASSWORD_HASH_PREFIX, PASSWORD_HASH_ITERATIONS, bytesToBase64(salt), bytesToBase64(digest)].join('$');
}

export async function verifyPassword(password: string, storedValue: string): Promise<boolean> {
  if (!isPasswordHash(storedValue)) {
    // Compatibility path for pre-hash records. App startup migrates these to
    // PBKDF2; keep this fallback so an interrupted migration cannot lock users out.
    return password === storedValue;
  }

  try {
    const [algorithm, iterationText, saltText, digestText] = storedValue.split('$');
    const iterations = Number(iterationText);
    if (algorithm !== PASSWORD_HASH_PREFIX || !Number.isInteger(iterations) || iterations < 100_000 || iterations > 1_000_000 || !saltText || !digestText) {
      return false;
    }

    const subtle = getSubtleCrypto();
    const salt = base64ToBytes(saltText);
    const expected = base64ToBytes(digestText);
    if (salt.length !== 16 || expected.length !== PASSWORD_HASH_BYTES) return false;
    const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      key,
      PASSWORD_HASH_BYTES * 8,
    );
    const actual = new Uint8Array(bits);
    let difference = 0;
    for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ actual[i];
    return difference === 0;
  } catch {
    return false;
  }
}
