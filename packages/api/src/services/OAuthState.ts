import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_RETURN_TO_LENGTH = 2048;
const RETURN_TO_PATTERN = /^\/(?!\/)[^\s\\]*$/;

export interface IOAuthStatePayload {
    providerId: string;
    returnTo: string;
}

export interface IOAuthStateKeyConfig {
    AUTH_JWT_SECRET?: string;
    AUTH_JWT_SECRET_B64?: string;
    AUTH_JWT_ED_SECRET?: string;
}

/** Only same-origin absolute paths are allowed; anything else (scheme-relative, absolute URLs, backslashes) becomes `/`. */
export function sanitizeReturnTo(value: unknown): string {
    if (typeof value !== 'string' || value.length > MAX_RETURN_TO_LENGTH || !RETURN_TO_PATTERN.test(value)) return '/';
    return value;
}

/** Derives a dedicated HMAC key from the JWT secret so the state signature is domain-separated from session JWTs. */
export function deriveStateKey(cfg: IOAuthStateKeyConfig): Buffer {
    const secret = cfg.AUTH_JWT_SECRET ?? cfg.AUTH_JWT_SECRET_B64 ?? cfg.AUTH_JWT_ED_SECRET;
    if (!secret) throw new Error('No AUTH_JWT_SECRET, AUTH_JWT_SECRET_B64 or AUTH_JWT_ED_SECRET is configured; cannot sign OAuth state');
    return createHmac('sha256', secret).update('pixelci:oauth-state:v1').digest();
}

function sign(body: string, key: Buffer | string): Buffer {
    return createHmac('sha256', key).update(body).digest();
}

export function createOAuthState(payload: IOAuthStatePayload, key: Buffer | string, nowMs: number = Date.now()): string {
    const body = Buffer.from(
        JSON.stringify({
            v: 1,
            p: payload.providerId,
            r: sanitizeReturnTo(payload.returnTo),
            n: randomBytes(16).toString('base64url'),
            e: nowMs + OAUTH_STATE_TTL_MS
        })
    ).toString('base64url');
    return `${body}.${sign(body, key).toString('base64url')}`;
}

export function verifyOAuthState(state: unknown, key: Buffer | string, nowMs: number = Date.now()): IOAuthStatePayload | null {
    if (typeof state !== 'string' || state.length > 4096) return null;
    const parts = state.split('.');
    if (parts.length !== 2) return null;
    const [body, sig] = parts;

    const expected = sign(body, key);
    const provided = Buffer.from(sig, 'base64url');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

    try {
        const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!data || data.v !== 1 || typeof data.p !== 'string' || typeof data.e !== 'number' || data.e < nowMs) return null;
        return { providerId: data.p, returnTo: sanitizeReturnTo(data.r) };
    } catch {
        return null;
    }
}
