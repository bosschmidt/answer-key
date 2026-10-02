// PBKDF2-HMAC-SHA256 + AES-256-GCM. The Mac side is tools/akcrypto.py; keep the two in step.
// Book file = 12-byte IV + ciphertext + tag, with the book id as authenticated data.

export const CHECK_TEXT = 'answer-key';
export const CHECK_AAD = 'check';

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 32 raw key bytes from the passphrase. kdf = {salt (base64), iterations} from the index.
export async function deriveBits(passphrase, kdf) {
  const text = new TextEncoder().encode(passphrase.normalize('NFC').trim());
  const material = await crypto.subtle.importKey('raw', text, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(kdf.salt), iterations: kdf.iterations }, material, 256);
  return new Uint8Array(bits);
}

export function importKey(raw) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
}

export async function decrypt(key, bytes, aad) {
  const data = new Uint8Array(bytes);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.subarray(0, 12), additionalData: new TextEncoder().encode(aad) },
    key, data.subarray(12));
  return new Uint8Array(plain);
}

// True when the key opens the index's check value, i.e. the passphrase is right.
export async function keyFits(key, index) {
  try {
    const plain = await decrypt(key, b64ToBytes(index.check), CHECK_AAD);
    return new TextDecoder().decode(plain) === CHECK_TEXT;
  } catch {
    return false;
  }
}
