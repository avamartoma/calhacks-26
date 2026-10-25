// AES-256-GCM with a key derived from KEY_ENCRYPTION_SECRET, which is set on the Convex
// deployment and never leaves it. Web Crypto, so it runs in either Convex runtime.

declare const process: { env: Record<string, string | undefined> };

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

async function secretKey(): Promise<CryptoKey> {
  const secret = process.env.KEY_ENCRYPTION_SECRET;
  if (!secret || secret.length < 32) throw new Error("KEY_ENCRYPTION_SECRET must be set in the Convex environment");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptKey(plain: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await secretKey(), new TextEncoder().encode(plain));
  return { ciphertext: toBase64(new Uint8Array(body)), iv: toBase64(iv) };
}

export async function decryptKey(stored: { ciphertext: string; iv: string }): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(stored.iv) }, await secretKey(), fromBase64(stored.ciphertext));
  return new TextDecoder().decode(plain);
}
