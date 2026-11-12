import { Crypto, getAppConfig } from '@zyno-io/ts-server-foundation';

export const SEALED_PREFIX = 'pcienc:v1:';

/** A sealed value that cannot be opened: malformed, failed authentication (wrong key or tampering), or no key configured. */
export class SecretUnreadableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SecretUnreadableError';
    }
}

/** Thin wrapper over TSF's `Crypto` (AES-256-GCM) that marks sealed values with a prefix so legacy plaintext stays readable. */
export class SecretBox {
    private readonly crypto?: Crypto;

    /** `secret` is a 32-byte string or 64 hex characters; an invalid secret throws. */
    constructor(secret?: string) {
        if (secret && secret.trim()) this.crypto = new Crypto({ secret });
    }

    get enabled(): boolean {
        return !!this.crypto;
    }

    /** Disabled mode returns plaintext. */
    seal(plain: string): string {
        if (!this.crypto || plain === '') return plain;
        return SEALED_PREFIX + this.crypto.encrypt(plain);
    }

    /** Values without the sealed prefix (legacy plaintext, test seeds) pass through unchanged. */
    open(value: string): string {
        if (typeof value !== 'string') throw new SecretUnreadableError('Stored secret is missing');
        if (!value.startsWith(SEALED_PREFIX)) return value;
        if (!this.crypto) throw new SecretUnreadableError('Sealed secret cannot be read: CRYPTO_SECRET is not set');
        try {
            return this.crypto.decrypt(value.slice(SEALED_PREFIX.length));
        } catch {
            throw new SecretUnreadableError('Sealed secret could not be decrypted (wrong CRYPTO_SECRET, malformed or tampered value)');
        }
    }

    /** True for non-empty plaintext when sealing is enabled. */
    needsSeal(value: string): boolean {
        return !!this.crypto && value !== '' && !value.startsWith(SEALED_PREFIX);
    }
}

let singleton: SecretBox | undefined;

function readKeySpec(): string | undefined {
    try {
        const fromConfig = getAppConfig<{ CRYPTO_SECRET?: string } & ReturnType<typeof getAppConfig>>().CRYPTO_SECRET;
        if (fromConfig) return fromConfig;
    } catch {
        // no app yet (e.g. unit tests); fall through to the environment
    }
    return process.env.CRYPTO_SECRET;
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
 * Throws on a malformed secret, or on a missing secret when APP_ENV is production; otherwise warns once.
 */
export function assertSecretsConfig(config: { APP_ENV?: string; CRYPTO_SECRET?: string }): void {
    const box = new SecretBox(config.CRYPTO_SECRET); // throws when malformed
    if (box.enabled) return;
    if (config.APP_ENV === 'production') {
        throw new Error('CRYPTO_SECRET is required when APP_ENV=production (generate one with: openssl rand -hex 32)');
    }
    if (!warned) {
        warned = true;
        console.warn('WARNING: CRYPTO_SECRET is not set; VCS secrets are stored in plaintext (allowed outside production only)');
    }
}
let warned = false;
