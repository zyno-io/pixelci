import { OAUTH_MAX_REDIRECT_URI_LENGTH } from './OAuthConstants';
import { isLoopbackHostname, isLoopbackLikeHost } from './OAuthUrls';

/** Control characters, whitespace and backslashes are never legitimate in a registered or requested redirect URI. */
// oxlint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000- \u007f-\u009f\\]/;

function parse(uri: string): URL | undefined {
    if (typeof uri !== 'string' || !uri || uri.length > OAUTH_MAX_REDIRECT_URI_LENGTH || FORBIDDEN_CHARS.test(uri) || uri.includes('#')) {
        return undefined;
    }
    // The authority must be written out ('https:///x' and 'https:x' are repaired by the URL parser into something else).
    if (!/^https?:\/\/[^/?]/i.test(uri)) return undefined;
    try {
        const url = new URL(uri);
        if (url.username || url.password || url.hash) return undefined;
        return url;
    } catch {
        return undefined;
    }
}

/** A redirect URI that may be registered: https with a host, or http on a loopback host. No fragment, no credentials, no other scheme. */
export function isValidRedirectUri(uri: string): boolean {
    const url = parse(uri);
    if (!url || !url.hostname) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
}

function isLoopbackHttp(url: URL): boolean {
    return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
}

/**
 * Whether `requested` is acceptable for a client that registered `registered`: exact string equality, except that a loopback URI
 * matches on scheme, host, path and query with ANY port (RFC 8252 section 7.3).
 */
export function redirectUriMatches(registered: string, requested: string): boolean {
    if (registered === requested) return true;
    const reg = parse(registered);
    const req = parse(requested);
    if (!reg || !req || !isLoopbackHttp(reg) || !isLoopbackHttp(req)) return false;
    return reg.hostname.toLowerCase() === req.hostname.toLowerCase() && reg.pathname === req.pathname && reg.search === req.search;
}

export function matchesAnyRedirectUri(registered: string[], requested: string): boolean {
    return registered.some(uri => redirectUriMatches(uri, requested));
}

export interface IRedirectDisplay {
    redirectDisplay: string;
    redirectKind: 'web' | 'loopback';
}

/** What the consent screen shows as the place the user is sent back to: the host for web apps, a plain label for loopback apps. */
export function describeRedirectUri(uri: string): IRedirectDisplay {
    const url = parse(uri);
    if (!url) return { redirectDisplay: 'an unknown location', redirectKind: 'web' };
    // Loopback over https is still the user's own machine.
    if (isLoopbackLikeHost(url.hostname)) return { redirectDisplay: `an app on this computer (${url.host})`, redirectKind: 'loopback' };
    return { redirectDisplay: url.host, redirectKind: 'web' };
}
