import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** A prefixed token with 256 bits of randomness. */
export function generateToken(prefix: string): string {
    return prefix + randomBytes(32).toString('base64url');
}

/** SHA-256 hex of the full prefixed token/code/secret: the only form of these values that is ever stored. */
export function hashToken(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time string comparison (over fixed-length digests, so length differences don't leak either). */
export function safeEqual(a: string, b: string): boolean {
    return timingSafeEqual(createHash('sha256').update(a, 'utf8').digest(), createHash('sha256').update(b, 'utf8').digest());
}

export const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
export const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/** RFC 7636 S256: BASE64URL(SHA256(verifier)). */
export function pkceS256(verifier: string): string {
    return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function verifyPkce(verifier: string, challenge: string): boolean {
    if (!PKCE_VERIFIER_RE.test(verifier)) return false;
    return safeEqual(pkceS256(verifier), challenge);
}
