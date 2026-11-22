import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * The correct answers are stored inside the quiz comment, encrypted with
 * AES-256-GCM so nobody can read them from the page source.
 *
 * - keyMode "secret": key derived from the `CAPITO_SECRET` repository secret.
 *   Tamper-proof: only the workflow can decrypt.
 * - keyMode "public": key derived from the repository name. Used when no secret
 *   is available (e.g. pull requests from forks). A determined person could
 *   decode it; acceptable because Capito never blocks anything.
 */
export type KeyMode = 'secret' | 'public';

export function deriveKey(mode: KeyMode, repo: string, secret?: string): Buffer {
  const material = mode === 'secret' && secret ? `capito:v1:secret:${secret}` : `capito:v1:public:${repo.toLowerCase()}`;
  return createHash('sha256').update(material).digest();
}

export function seal(payload: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString('base64url');
}

export function unseal<T>(sealed: string, key: Buffer): T | null {
  try {
    const buf = Buffer.from(sealed, 'base64url');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const text = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Short, non-reversible pseudonym for a username (used when `anonymous: true`). */
export function pseudonym(user: string, salt: string): string {
  return 'anon-' + createHash('sha256').update(`${salt}:${user.toLowerCase()}`).digest('hex').slice(0, 8);
}
