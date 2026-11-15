export interface IOAuthUrls {
    /** The PUBLIC_URL origin, no trailing slash. Also the OAuth issuer. */
    issuer: string;
    /** The protected resource (the MCP endpoint) tokens are bound to. */
    resource: string;
    /** Path-suffixed protected-resource metadata URL (what WWW-Authenticate points at). */
    protectedResourceMetadata: string;
    authorization: string;
    token: string;
    registration: string;
    revocation: string;
    /** SPA routes the authorize endpoint redirects to. */
    consent: string;
    error: string;
}

export const OAUTH_MCP_PATH = '/api/mcp';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackHostname(hostname: string): boolean {
    return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * The OAuth URLs for this deployment, or null when OAuth is unavailable: disabled, or PUBLIC_URL is not a bare origin
 * (path `/`, no query or fragment, no credentials) on https (http is allowed only for a loopback host, for development).
 * The issuer comes only from config, never from a request header.
 */
export function getOAuthUrls(config: { MCP_OAUTH_ENABLED?: boolean; PUBLIC_URL?: string }): IOAuthUrls | null {
    if (!config.MCP_OAUTH_ENABLED) return null;
    const raw = config.PUBLIC_URL?.trim();
    if (!raw || raw.includes('?') || raw.includes('#')) return null;

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
    const secure = url.protocol === 'https:';
    if (!secure && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) return null;

    const issuer = url.origin;
    return {
        issuer,
        resource: `${issuer}${OAUTH_MCP_PATH}`,
        protectedResourceMetadata: `${issuer}/.well-known/oauth-protected-resource${OAUTH_MCP_PATH}`,
        authorization: `${issuer}/api/oauth/authorize`,
        token: `${issuer}/api/oauth/token`,
        registration: `${issuer}/api/oauth/register`,
        revocation: `${issuer}/api/oauth/revoke`,
        consent: `${issuer}/oauth/consent`,
        error: `${issuer}/oauth/error`
    };
}

/**
 * Normalizes a requested `resource` indicator list to the canonical resource. Zero values mean the canonical resource; exactly one
 * must be an absolute URL with the issuer's origin, no query or fragment, and a path (trailing slashes stripped) of '' or the MCP
 * path. Anything else is invalid (undefined). There is a single audience, so the leniency cannot widen access.
 */
export function normalizeResource(values: string[], urls: Pick<IOAuthUrls, 'issuer' | 'resource'>): string | undefined {
    if (values.length === 0) return urls.resource;
    if (values.length > 1) return undefined;
    const raw = values[0];
    if (raw.includes('#') || raw.includes('?')) return undefined;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return undefined;
    }
    if (url.origin !== urls.issuer || url.search || url.hash || url.username || url.password) return undefined;
    const path = url.pathname.replace(/\/+$/, '');
    if (path !== '' && path !== OAUTH_MCP_PATH) return undefined;
    return urls.resource;
}
