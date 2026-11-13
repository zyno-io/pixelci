import { Crypto, getAppConfig } from '@zyno-io/ts-server-foundation';

export const MISSING_SECRET_MESSAGE = 'CRYPTO_SECRET is required (generate one with: openssl rand -hex 32)';

/** A sealed value that cannot be opened: malformed, failed authentication (wrong key or tampering), or missing. */
export class SecretUnreadableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SecretUnreadableError';
    }
}

/** Thin wrapper over TSF's `Crypto` (AES-256-GCM). Every stored secret is ciphertext; there is no plaintext mode. */
export class SecretBox {
    private readonly crypto: Crypto;

    /** `secret` is a 32-byte string or 64 hex characters; a missing or invalid secret throws. */
    constructor(secret?: string) {
        if (!secret || !secret.trim()) throw new Error(MISSING_SECRET_MESSAGE);
        this.crypto = new Crypto({ secret });
    }

    seal(plain: string): string {
        return this.crypto.encrypt(plain);
    }

    open(value: string): string {
        if (typeof value !== 'string') throw new SecretUnreadableError('Stored secret is missing');
        try {
            return this.crypto.decrypt(value);
        } catch {
            throw new SecretUnreadableError('Stored secret could not be decrypted (wrong CRYPTO_SECRET, malformed or tampered value)');
        }
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

/** Validates CRYPTO_SECRET at app boot and in the encrypt_secrets migration. Throws when missing or malformed, in every environment. */
export function assertSecretsConfig(config: { CRYPTO_SECRET?: string }): void {
    new SecretBox(config.CRYPTO_SECRET);
}
