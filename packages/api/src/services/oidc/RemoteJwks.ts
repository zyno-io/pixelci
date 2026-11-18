import { createRemoteJWKSet, errors, jwtVerify } from 'jose';

import { BoundedTtlCache } from '../../helpers/BoundedTtlCache';

const jwksCache = new BoundedTtlCache<ReturnType<typeof createRemoteJWKSet>>(32, 24 * 60 * 60_000);

/** A cached remote JWKS (jose handles key refresh and cooldowns); one per URL. */
export function getRemoteJwks(jwksUrl: string) {
    let jwks = jwksCache.get(jwksUrl);
    if (!jwks) {
        jwks = createRemoteJWKSet(new URL(jwksUrl));
        jwksCache.set(jwksUrl, jwks);
    }
    return jwks;
}

export interface IVerifyOidcJwtOptions {
    issuer: string | string[];
    jwksUrl: string;
    audience: string[];
    algorithms: string[];
    clockTolerance?: number;
}

/**
 * Verifies a compact JWS against a remote JWKS. Requires `exp`. Throws on an empty audience list: jose skips the `aud`
 * check when `audience` is undefined, so an empty list must fail closed rather than accept any audience.
 */
export async function verifyOidcJwt(token: string, options: IVerifyOidcJwtOptions): Promise<Record<string, unknown>> {
    if (!options.audience.length) throw new Error('No accepted audiences configured');
    const result = await jwtVerify(token, getRemoteJwks(options.jwksUrl), {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: options.algorithms,
        requiredClaims: ['exp'],
        ...(options.clockTolerance !== undefined && { clockTolerance: options.clockTolerance })
    });
    return result.payload;
}

/**
 * Whether an error from `verifyOidcJwt` means the token itself is bad (a 401), as opposed to the JWKS being unreachable
 * (network, timeout, bad response), which is transient.
 */
export function isOidcTokenRejection(err: unknown): boolean {
    return (
        err instanceof errors.JWSSignatureVerificationFailed ||
        err instanceof errors.JWTClaimValidationFailed ||
        // a sibling of JWTClaimValidationFailed in jose, not a subclass
        err instanceof errors.JWTExpired ||
        err instanceof errors.JWSInvalid ||
        err instanceof errors.JWTInvalid ||
        err instanceof errors.JWKSNoMatchingKey ||
        err instanceof errors.JWKSMultipleMatchingKeys ||
        err instanceof errors.JOSEAlgNotAllowed ||
        err instanceof errors.JOSENotSupported
    );
}

/** First line of a commit message, at most 255 characters (the builds.commitSubject column). */
export function extractCommitSubject(message: unknown): string {
    if (typeof message !== 'string') return '';
    return message.split(/\r?\n/, 1)[0].trim().slice(0, 255);
}
