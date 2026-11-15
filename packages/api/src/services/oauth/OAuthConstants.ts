export const OAUTH_SCOPE = 'mcp:read';
export const OAUTH_SCOPE_DESCRIPTION = 'Read apps, builds, review decisions, comments and screenshots you can access';

export const OAUTH_PENDING_REQUEST_TTL_MS = 15 * 60_000;
export const OAUTH_CODE_TTL_MS = 2 * 60_000;
export const OAUTH_ACCESS_TOKEN_TTL_MS = 60 * 60_000;
/** A refresh token idle (unused) for this long stops working. */
export const OAUTH_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
/** Absolute lifetime of a grant (and of every token in it), however often it is refreshed. */
export const OAUTH_GRANT_TTL_MS = 90 * 24 * 60 * 60_000;
/** A rotated refresh token presented again within this window gets a fresh pair (a client retrying a lost response). Later is reuse. */
export const OAUTH_REFRESH_REUSE_LEEWAY_MS = 30_000;
/** How often a grant's lastUsedAt is bumped by API use. */
export const OAUTH_LAST_USED_THROTTLE_MS = 5 * 60_000;

export const OAUTH_PREFIX_ACCESS = 'pixelci_at_';
export const OAUTH_PREFIX_REFRESH = 'pixelci_rt_';
export const OAUTH_PREFIX_CODE = 'pixelci_ac_';
export const OAUTH_PREFIX_CLIENT_SECRET = 'pixelci_cs_';
/** Every PixelCI-issued credential starts with this; none of them is ever forwarded to a VCS provider. */
export const OAUTH_PREFIX_ANY = 'pixelci_';

export const OAUTH_DEFAULT_CLIENT_NAME = 'Unnamed MCP client';
export const OAUTH_MAX_CLIENT_NAME_LENGTH = 100;
export const OAUTH_MAX_REDIRECT_URIS = 10;
export const OAUTH_MAX_REDIRECT_URI_LENGTH = 2048;
export const OAUTH_MAX_STATE_LENGTH = 4096;

export const OAUTH_REGISTER_BODY_LIMIT = 16 * 1024;
export const OAUTH_TOKEN_BODY_LIMIT = 8 * 1024;

export type OAuthClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';
export const OAUTH_AUTH_METHODS: readonly OAuthClientAuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic'];

export type OAuthRevokedReason = 'user' | 'client_revoke' | 'refresh_reuse' | 'code_reuse' | 'vcs_session' | 'superseded';
