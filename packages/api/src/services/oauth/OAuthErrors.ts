import { rawResponse } from '@zyno-io/ts-server-foundation';

import { OAUTH_SCOPE } from './OAuthConstants';
import { IOAuthUrls } from './OAuthUrls';

export type OAuthErrorCode =
    | 'invalid_request'
    | 'invalid_client'
    | 'invalid_grant'
    | 'invalid_scope'
    | 'invalid_target'
    | 'unauthorized_client'
    | 'unsupported_grant_type'
    | 'unsupported_response_type'
    | 'invalid_redirect_uri'
    | 'invalid_client_metadata'
    | 'access_denied'
    | 'temporarily_unavailable'
    | 'not_found';

/** An OAuth protocol error. `description` is always a fixed string: never put request input in it. */
export class OAuthError extends Error {
    constructor(
        readonly code: OAuthErrorCode,
        readonly description: string,
        readonly status = 400,
        readonly headers: Record<string, string> = {}
    ) {
        super(`${code}: ${description}`);
    }
}

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' } as const;

/** A JSON response with no-store headers (every OAuth response that isn't discovery metadata). */
export function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return rawResponse(JSON.stringify(body), { statusCode: status, contentType: 'application/json', headers: { ...NO_STORE, ...headers } });
}

export function oauthErrorResponse(err: OAuthError) {
    return oauthJson({ error: err.code, error_description: err.description }, err.status, err.headers);
}

export function notFoundResponse() {
    return oauthJson({ error: 'not_found' }, 404);
}

/** Strips characters that would break out of a quoted WWW-Authenticate auth-param. */
function quote(value: string): string {
    return value.replace(/["\\\r\n]/g, '');
}

/**
 * The WWW-Authenticate challenge for /api/mcp. With OAuth unavailable it is a bare `Bearer realm`, so clients don't go looking for
 * metadata that doesn't exist.
 */
export function bearerChallenge(urls: IOAuthUrls | null, opts: { error?: string; description?: string } = {}): string {
    const parts: string[] = [];
    if (urls) {
        parts.push(`resource_metadata="${quote(urls.protectedResourceMetadata)}"`, `scope="${OAUTH_SCOPE}"`);
    } else {
        parts.push('realm="PixelCI"');
    }
    if (opts.error) parts.push(`error="${quote(opts.error)}"`);
    if (opts.description) parts.push(`error_description="${quote(opts.description)}"`);
    return `Bearer ${parts.join(', ')}`;
}

/** A 401/403 for the MCP endpoint, carrying the challenge. */
export function bearerErrorResponse(urls: IOAuthUrls | null, status: 401 | 403, opts: { error?: string; description: string }) {
    return oauthJson({ error: opts.error ?? 'unauthorized', error_description: opts.description }, status, {
        'WWW-Authenticate': bearerChallenge(urls, opts.error ? opts : {})
    });
}

/** Parses an `Authorization: Bearer` header. Undefined when absent or not a bearer credential. */
export function parseBearer(header: string | undefined): string | undefined {
    if (typeof header !== 'string') return undefined;
    const match = /^Bearer +(\S+) *$/i.exec(header);
    return match?.[1];
}

/** Decodes an `Authorization: Basic` header into form-decoded client credentials (RFC 6749 section 2.3.1). Undefined when malformed. */
export function parseBasic(header: string | undefined): { id: string; secret: string } | undefined {
    if (typeof header !== 'string') return undefined;
    const match = /^Basic +([A-Za-z0-9+/=_-]+) *$/i.exec(header);
    if (!match) return undefined;
    let decoded: string;
    try {
        decoded = Buffer.from(match[1], 'base64').toString('utf8');
    } catch {
        return undefined;
    }
    const idx = decoded.indexOf(':');
    if (idx < 0) return undefined;
    try {
        const formDecode = (v: string) => decodeURIComponent(v.replace(/\+/g, ' '));
        return { id: formDecode(decoded.slice(0, idx)), secret: formDecode(decoded.slice(idx + 1)) };
    } catch {
        return undefined;
    }
}
