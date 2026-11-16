import { isIP } from 'node:net';
import { getDomain, parse as parseHost } from 'tldts';

import { cleanClientName } from './ClientName';
import { OAUTH_CIMD_MAX_REDIRECT_URIS } from './OAuthConstants';
import { isLoopbackLikeHost } from './OAuthUrls';
import { describeRedirectUri, isValidRedirectUri } from './RedirectUris';

/*
 * Pure rules for Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document, MCP 2025-11-25): what a client_id URL
 * may look like, what its document must contain, how long it may be cached and how the consent screen describes it.
 */

const MAX_CLIENT_ID_LENGTH = 2048;
/** Whitespace, control characters and backslashes never appear in an acceptable client_id. */
// oxlint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000- \u007f-\u009f\\]/;
const DOT_SEGMENT_RE = /\/(\.|%2e){1,2}(\/|$)/i;
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.arpa', '.svc', '.cluster.local'];

export type ClientIdParse = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Checks a client_id URL before any network I/O. The URL must already be canonical (`url.href === raw`), so one client has exactly
 * one spelling and the stored key is unambiguous. Never normalizes: anything that would need it is rejected.
 */
export function parseClientIdUrl(raw: unknown): ClientIdParse {
    const fail = (reason: string): ClientIdParse => ({ ok: false, reason });
    if (typeof raw !== 'string' || !raw) return fail('not a string');
    if (raw.length > MAX_CLIENT_ID_LENGTH) return fail('too long');
    if (FORBIDDEN_CHARS.test(raw)) return fail('forbidden character');
    if (raw.includes('#')) return fail('fragment');
    if (raw.includes('?')) return fail('query');
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return fail('not a URL');
    }
    if (url.href !== raw) return fail('not canonical');
    if (url.protocol !== 'https:') return fail('not https');
    if (url.username || url.password) return fail('userinfo');
    if (url.search || url.hash) return fail('query or fragment');
    if (url.pathname === '/' || !url.pathname) return fail('root path');
    if (DOT_SEGMENT_RE.test(raw)) return fail('dot segment');
    if (url.port !== '') return fail('port');

    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (isIP(host) !== 0) return fail('IP literal');
    if (!host.includes('.') || host.endsWith('.') || host === 'localhost') return fail('not a public DNS name');
    if (BLOCKED_SUFFIXES.some(s => host.endsWith(s))) return fail('internal name');
    return { ok: true, url };
}

export interface IValidClientMetadata {
    name: string;
    redirectUris: string[];
}

export type ClientMetadataValidation = ({ ok: true } & IValidClientMetadata) | { ok: false; reason: string };

const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'];
const SHARED_SECRET_METHODS = ['client_secret_post', 'client_secret_basic', 'client_secret_jwt'];

/**
 * Validates a fetched document against the client_id it was fetched from. Only `none` client authentication is supported, so
 * documents that need a secret or a key (`private_key_jwt`) are refused. Fields we don't use (`logo_uri`, `jwks`, ...) are ignored
 * and never fetched.
 */
export function validateClientMetadataDocument(json: unknown, clientIdUrl: string): ClientMetadataValidation {
    const fail = (reason: string): ClientMetadataValidation => ({ ok: false, reason });
    if (!json || typeof json !== 'object' || Array.isArray(json)) return fail('not an object');
    const doc = json as Record<string, unknown>;
    const has = (key: string) => Object.prototype.hasOwnProperty.call(doc, key);

    if (typeof doc.client_id !== 'string' || doc.client_id !== clientIdUrl) return fail('client_id mismatch');
    if (has('client_secret') || has('client_secret_expires_at')) return fail('carries a client secret');

    // Absent means `none` (not RFC 7591's client_secret_basic default). Each declaration that is present must allow `none`.
    if (has('token_endpoint_auth_method')) {
        const method = doc.token_endpoint_auth_method;
        if (typeof method !== 'string') return fail('malformed token_endpoint_auth_method');
        if (SHARED_SECRET_METHODS.includes(method)) return fail('shared-secret auth method');
        if (method !== 'none') return fail('unsupported auth method');
    }
    if (has('token_endpoint_auth_methods_supported')) {
        const methods = doc.token_endpoint_auth_methods_supported;
        if (!Array.isArray(methods) || !methods.every(m => typeof m === 'string')) return fail('malformed token_endpoint_auth_methods_supported');
        if (methods.some(m => SHARED_SECRET_METHODS.includes(m))) return fail('shared-secret auth method');
        if (!methods.includes('none')) return fail('auth methods do not include none');
    }

    const filterTo = (key: string, allowed: string[]): string[] | undefined => {
        if (!has(key)) return undefined;
        const value = doc[key];
        if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) return [];
        return value.filter(v => allowed.includes(v));
    };
    const grants = filterTo('grant_types', SUPPORTED_GRANT_TYPES);
    if (grants && !grants.includes('authorization_code')) return fail('grant_types excludes authorization_code');
    const responses = filterTo('response_types', ['code']);
    if (responses && !responses.length) return fail('response_types excludes code');

    // Required by the MCP spec: the name is shown to the user, and there is nowhere to send them without redirect URIs.
    const name = cleanClientName(doc.client_name);
    if (!name) return fail('missing client_name');

    if (!Array.isArray(doc.redirect_uris)) return fail('missing redirect_uris');
    // Entries we can't honour (custom schemes for other platforms) are dropped rather than failing the document.
    const redirectUris = [...new Set(doc.redirect_uris.filter((u): u is string => typeof u === 'string' && isValidRedirectUri(u)))];
    if (redirectUris.length < 1) return fail('no usable redirect_uris');
    if (redirectUris.length > OAUTH_CIMD_MAX_REDIRECT_URIS) return fail('too many redirect_uris');

    return { ok: true, name, redirectUris };
}

export const CIMD_MIN_TTL_S = 300;
export const CIMD_MAX_TTL_S = 24 * 3600;
export const CIMD_DEFAULT_TTL_S = 3600;

/**
 * How long a document may be cached: `max-age` clamped to 5 minutes to 24 hours (1 hour when absent or malformed). `no-store` and
 * `no-cache` mean the floor. `Expires` and `s-maxage` are ignored.
 */
export function cacheTtlSeconds(cacheControl: string | undefined): number {
    if (!cacheControl) return CIMD_DEFAULT_TTL_S;
    const directives = cacheControl
        .toLowerCase()
        .split(',')
        .map(d => d.trim());
    if (directives.includes('no-store') || directives.includes('no-cache')) return CIMD_MIN_TTL_S;
    const maxAge = directives.map(d => /^max-age=(\d{1,10})$/.exec(d)).find(Boolean);
    if (!maxAge) return CIMD_DEFAULT_TTL_S;
    return Math.min(CIMD_MAX_TTL_S, Math.max(CIMD_MIN_TTL_S, Number(maxAge[1])));
}

/**
 * Hosts where anyone can publish a document without owning the host, so owning a client_id there says nothing about who the
 * publisher is. Two sources: the Public Suffix List private section (a user-controlled subdomain of a shared host, e.g.
 * `x.github.io`, `x.r2.dev`, `bucket.s3.us-east-1.amazonaws.com`), and this list for hosts that serve user content by path rather
 * than by subdomain, which the PSL cannot express.
 */
const SHARED_HOSTING_SUFFIXES = [
    'github.io',
    'githubusercontent.com',
    'raw.githubusercontent.com',
    'gist.githubusercontent.com',
    'gitlab.io',
    'pages.dev',
    'workers.dev',
    'r2.dev',
    'vercel.app',
    'netlify.app',
    'herokuapp.com',
    'web.app',
    'firebaseapp.com',
    'firebaseio.com',
    'glitch.me',
    'replit.app',
    'ngrok.io',
    'ngrok-free.app',
    'trycloudflare.com',
    'amazonaws.com',
    'storage.googleapis.com',
    'blob.core.windows.net',
    'azurewebsites.net',
    'cloudfront.net',
    'cdn.jsdelivr.net',
    'jsdelivr.net',
    'unpkg.com'
];

export function isSharedHostingHost(host: string): boolean {
    const h = host.replace(/\.$/, '').toLowerCase();
    if (SHARED_HOSTING_SUFFIXES.some(s => h === s || h.endsWith('.' + s))) return true;
    // Path-style S3 endpoints: s3.amazonaws.com, s3.<region>.amazonaws.com, s3-<region>.amazonaws.com, dualstack variants.
    if (/^s3[.-]([a-z0-9-]+\.)*amazonaws\.com(\.cn)?$/.test(h)) return true;
    const parsed = parseHost(h, { allowPrivateDomains: true });
    return parsed.isPrivate === true;
}

/** The registrable domain (eTLD+1, private suffixes included, so each `x.github.io` is its own), or the host itself. */
export function registrableDomain(host: string): string {
    const h = host.toLowerCase();
    return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

export type ClientVerification = 'unverified' | 'verified_domain' | 'claimed_domain';

export interface IClientIdentity {
    /** The ASCII (punycode) host of the client_id; never Unicode-decoded. Null for registered clients. */
    clientIdHost: string | null;
    verification: ClientVerification;
    /** Web redirects only: the redirect host is neither the client_id host nor a subdomain of it. */
    redirectOffDomain: boolean;
}

/**
 * How the consent screen should describe a client. A metadata client returning to an https URI its domain published is
 * `verified_domain` (served over valid TLS from that host, nothing more). A loopback redirect, or a document on a shared-hosting
 * suffix, proves nothing about who holds the code: `claimed_domain`.
 */
export function describeClientIdentity(metadataUrl: string | null, redirectUri: string): IClientIdentity {
    if (!metadataUrl) return { clientIdHost: null, verification: 'unverified', redirectOffDomain: false };
    let host: string;
    try {
        host = new URL(metadataUrl).hostname.toLowerCase();
    } catch {
        return { clientIdHost: null, verification: 'unverified', redirectOffDomain: false };
    }
    const { redirectKind } = describeRedirectUri(redirectUri);
    let redirectHost = '';
    try {
        redirectHost = new URL(redirectUri).hostname.toLowerCase();
    } catch {
        // describeRedirectUri already treated it as unknown
    }
    if (redirectKind === 'loopback' || isLoopbackLikeHost(redirectHost) || isSharedHostingHost(host)) {
        return { clientIdHost: host, verification: 'claimed_domain', redirectOffDomain: false };
    }
    const onDomain = redirectHost === host || redirectHost.endsWith('.' + host);
    return { clientIdHost: host, verification: 'verified_domain', redirectOffDomain: !onDomain };
}
