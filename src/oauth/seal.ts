import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Stateless, authenticated encryption (AES-256-GCM) for OAuth artefacts: DCR client ids, authorization codes,
 * access tokens and refresh tokens. The user's Apify token / API key travels INSIDE the sealed access token, so the
 * server keeps no credential database; clients (ChatGPT, Claude) only ever hold ciphertext.
 * Key rotation: SITEVERDICT_OAUTH_KEYS="newKey,oldKey" (base64url, 32 bytes each) — new tokens use the first key,
 * tokens sealed with any listed key still open. Each artefact type has its own AAD ("purpose") so a code can never be
 * replayed as an access token, etc.
 */
export type Purpose = 'client' | 'authreq' | 'code' | 'access' | 'refresh';

interface Key {
  id: string;
  raw: Buffer;
}

const b64u = (b: Buffer) => b.toString('base64url');

export function generateKey(): string {
  return b64u(randomBytes(32));
}

export class Sealer {
  private readonly keys: Key[];
  readonly ephemeral: boolean;

  constructor(keys: string[]) {
    this.ephemeral = keys.length === 0;
    const list = keys.length ? keys : [generateKey()];
    this.keys = list.map((k) => {
      const raw = Buffer.from(k, 'base64url');
      if (raw.length !== 32) throw new Error('SITEVERDICT_OAUTH_KEYS entries must be 32 random bytes, base64url-encoded (node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))").');
      return { id: createHash('sha256').update(raw).digest('hex').slice(0, 8), raw };
    });
  }

  seal(purpose: Purpose, payload: object): string {
    const key = this.keys[0]!;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key.raw, iv);
    c.setAAD(Buffer.from(`siteverdict:${purpose}`));
    const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
    return `${key.id}.${b64u(iv)}.${b64u(ct)}.${b64u(c.getAuthTag())}`;
  }

  /** Returns the payload, or undefined if the token is malformed, tampered with, or sealed for another purpose. */
  open<T>(purpose: Purpose, token: string): T | undefined {
    const parts = token.split('.');
    if (parts.length !== 4 || token.length > 16_384) return undefined;
    const [kid, iv, ct, tag] = parts as [string, string, string, string];
    const key = this.keys.find((k) => k.id === kid);
    if (!key) return undefined;
    try {
      const d = createDecipheriv('aes-256-gcm', key.raw, Buffer.from(iv, 'base64url'));
      d.setAAD(Buffer.from(`siteverdict:${purpose}`));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      const pt = Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
      return JSON.parse(pt.toString('utf8')) as T;
    } catch {
      return undefined;
    }
  }

  /** Deterministic client secret for confidential DCR clients (no storage needed). */
  clientSecret(clientId: string): string {
    return b64u(createHmac('sha256', this.keys[0]!.raw).update(`client-secret:${clientId}`).digest());
  }

  checkClientSecret(clientId: string, secret: string): boolean {
    return this.keys.some((k) => {
      const expected = createHmac('sha256', k.raw).update(`client-secret:${clientId}`).digest();
      const got = Buffer.from(secret, 'base64url');
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
  }
}

/** In-memory single-use / revocation list with expiry (per process; use a shared store for multi-instance). */
export class JtiList {
  private readonly map = new Map<string, number>();
  add(jti: string, expSecs: number): void {
    this.map.set(jti, expSecs);
    if (this.map.size > 50_000) {
      const now = Date.now() / 1000;
      for (const [k, v] of this.map) if (v < now) this.map.delete(k);
    }
  }
  has(jti: string): boolean {
    return this.map.has(jti);
  }
}
