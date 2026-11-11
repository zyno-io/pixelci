import { getAppConfig } from '@zyno-io/ts-server-foundation';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const SEALED_PREFIX = 'pcienc:v1:';
const KEY_ID_PATTERN = /^[a-z0-9]{1,16}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A sealed value that cannot be opened: malformed, failed authentication (wrong key under the same id, wrong context, tampering), or unknown key id. */
export class SecretUnreadableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SecretUnreadableError';
    }
}

export class SecretKeyUnavailableError extends SecretUnreadableError {
    constructor(public readonly keyId: string) {
        super(`Secret was sealed with key "${keyId}", which is not in SECRETS_ENCRYPTION_KEYS`);
        this.name = 'SecretKeyUnavailableError';
    }
}

export interface IKeyring {
    activeId: string;
    keys: Map<string, Buffer>;
}

/** Parses `"k2:<base64 32B>,k1:<base64 32B>"`. The first key is active; the rest are decrypt-only. */
export function parseKeyring(spec: string): IKeyring {
    const keys = new Map<string, Buffer>();
    const entries = spec
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    if (!entries.length) throw new Error('SECRETS_ENCRYPTION_KEYS is empty');
    for (const entry of entries) {
        const sep = entry.indexOf(':');
        const id = sep < 0 ? '' : entry.slice(0, sep);
        const b64 = sep < 0 ? '' : entry.slice(sep + 1);
        if (!KEY_ID_PATTERN.test(id))
            throw new Error('SECRETS_ENCRYPTION_KEYS: each entry must be "<id>:<base64 key>" with id matching [a-z0-9]{1,16}');
        if (keys.has(id)) throw new Error(`SECRETS_ENCRYPTION_KEYS: duplicate key id "${id}"`);
        if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) throw new Error(`SECRETS_ENCRYPTION_KEYS: key "${id}" is not valid base64`);
        const key = Buffer.from(b64, 'base64');
        if (key.length !== 32) throw new Error(`SECRETS_ENCRYPTION_KEYS: key "${id}" must be 32 bytes (got ${key.length})`);
        keys.set(id, key);
    }
    return { activeId: keys.keys().next().value as string, keys };
}

function parseSealed(value: string): { kid: string; payload: Buffer } {
    const rest = value.slice(SEALED_PREFIX.length);
    const sep = rest.indexOf(':');
    if (sep < 0) throw new SecretUnreadableError('Malformed sealed secret');
    return { kid: rest.slice(0, sep), payload: Buffer.from(rest.slice(sep + 1), 'base64url') };
}

export class SecretBox {
    private readonly ring?: IKeyring;

    constructor(spec?: string) {
        if (spec && spec.trim()) this.ring = parseKeyring(spec);
    }

    get enabled(): boolean {
        return !!this.ring;
    }

    get activeKeyId(): string | undefined {
        return this.ring?.activeId;
    }

    /** `ctx` is bound as AAD, so a sealed value only opens in the place it was sealed for. Disabled mode returns plaintext. */
    seal(plain: string, ctx: string): string {
        if (!this.ring || plain === '') return plain;
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv('aes-256-gcm', this.ring.keys.get(this.ring.activeId)!, iv);
        cipher.setAAD(Buffer.from(ctx, 'utf8'));
        const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        return `${SEALED_PREFIX}${this.ring.activeId}:${Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64url')}`;
    }

    /** Values without the sealed prefix (legacy plaintext, test seeds) pass through unchanged. */
    open(value: string, ctx: string): string {
        if (!value.startsWith(SEALED_PREFIX)) return value;
        const { kid, payload } = parseSealed(value);
        const key = this.ring?.keys.get(kid);
        if (!key) throw new SecretKeyUnavailableError(kid);
        if (payload.length < IV_BYTES + TAG_BYTES) throw new SecretUnreadableError('Malformed sealed secret');
        const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, IV_BYTES));
        decipher.setAAD(Buffer.from(ctx, 'utf8'));
        decipher.setAuthTag(payload.subarray(payload.length - TAG_BYTES));
        try {
            return Buffer.concat([decipher.update(payload.subarray(IV_BYTES, payload.length - TAG_BYTES)), decipher.final()]).toString('utf8');
        } catch {
            throw new SecretUnreadableError('Sealed secret failed authentication (wrong key, context or tampered value)');
        }
    }

    /** True for plaintext (when enabled) or a value sealed with a non-active key. */
    needsReseal(value: string): boolean {
        if (!this.ring || value === '') return false;
        if (!value.startsWith(SEALED_PREFIX)) return true;
        return parseSealed(value).kid !== this.ring.activeId;
    }
}

let singleton: SecretBox | undefined;

function readKeySpec(): string | undefined {
    try {
        const fromConfig = getAppConfig<{ SECRETS_ENCRYPTION_KEYS?: string } & ReturnType<typeof getAppConfig>>().SECRETS_ENCRYPTION_KEYS;
        if (fromConfig) return fromConfig;
    } catch {
        // no app yet (e.g. unit tests); fall through to the environment
    }
    return process.env.SECRETS_ENCRYPTION_KEYS;
}

export function getSecretBox(): SecretBox {
    return (singleton ??= new SecretBox(readKeySpec()));
}

/** For tests: replace or clear the lazily-built singleton. */
export function setSecretBoxForTesting(box: SecretBox | undefined): void {
    singleton = box;
}

/**
 * The one place that decides whether sealing is mandatory. Used by app boot and the encrypt_secrets migration.
 * Throws on a malformed keyring, or on a missing keyring when APP_ENV is production; otherwise warns once.
 */
export function assertSecretsConfig(config: { APP_ENV?: string; SECRETS_ENCRYPTION_KEYS?: string }): void {
    const spec = config.SECRETS_ENCRYPTION_KEYS;
    const box = new SecretBox(spec); // throws when malformed
    if (box.enabled) return;
    if (config.APP_ENV === 'production') {
        throw new Error('SECRETS_ENCRYPTION_KEYS is required when APP_ENV=production (generate one with: openssl rand -base64 32, as "k1:<key>")');
    }
    if (!warned) {
        warned = true;
        console.warn('WARNING: SECRETS_ENCRYPTION_KEYS is not set; VCS secrets are stored in plaintext (allowed outside production only)');
    }
}
let warned = false;
