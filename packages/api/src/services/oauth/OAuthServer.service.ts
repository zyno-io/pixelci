import { createPersistedEntity, ScopedLogger, uuid4 } from '@zyno-io/ts-server-foundation';

import { AppConfig } from '../../config';
import { Db } from '../../database';
import { OAuthAuthorizationEntity } from '../../entities/OAuthAuthorization.entity';
import { OAuthClientEntity } from '../../entities/OAuthClient.entity';
import { OAuthGrantEntity } from '../../entities/OAuthGrant.entity';
import { OAuthTokenEntity } from '../../entities/OAuthToken.entity';
import {
    OAUTH_ACCESS_TOKEN_TTL_MS,
    OAUTH_AUTH_METHODS,
    OAUTH_CODE_TTL_MS,
    OAUTH_DEFAULT_CLIENT_NAME,
    OAUTH_GRANT_TTL_MS,
    OAUTH_LAST_USED_THROTTLE_MS,
    OAUTH_MAX_CLIENT_NAME_LENGTH,
    OAUTH_MAX_REDIRECT_URIS,
    OAUTH_MAX_STATE_LENGTH,
    OAUTH_PENDING_REQUEST_TTL_MS,
    OAUTH_PREFIX_ACCESS,
    OAUTH_PREFIX_CLIENT_SECRET,
    OAUTH_PREFIX_CODE,
    OAUTH_PREFIX_REFRESH,
    OAUTH_REFRESH_REUSE_LEEWAY_MS,
    OAUTH_REFRESH_TOKEN_TTL_MS,
    OAUTH_SCOPE,
    OAuthClientAuthMethod,
    OAuthRevokedReason
} from './OAuthConstants';
import { generateToken, hashToken, PKCE_CHALLENGE_RE, PKCE_VERIFIER_RE, safeEqual, verifyPkce } from './OAuthCrypto';
import { OAuthError } from './OAuthErrors';
import { OAuthPolicy } from './OAuthPolicy';
import { getOAuthUrls, IOAuthUrls, normalizeResource } from './OAuthUrls';
import { isValidRedirectUri, matchesAnyRedirectUri } from './RedirectUris';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Control, bidi-override and zero-width characters: never shown in a client name. */
// oxlint-disable-next-line no-control-regex
const NAME_STRIP_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

export interface IRegisteredClient {
    client: OAuthClientEntity;
    /** Plaintext secret, returned once at registration; only its hash is stored. */
    clientSecret?: string;
}

export interface ITokenResponse {
    access_token: string;
    token_type: 'Bearer';
    expires_in: number;
    refresh_token: string;
    scope: string;
}

/** Why an authorize request couldn't be trusted enough to redirect to the client. */
export type AuthorizeErrorReason = 'invalid_client' | 'invalid_redirect_uri' | 'invalid_request';

export type AuthorizeResult =
    /** Send the user to our own error page: the client or redirect URI is unverified, so nothing may be sent to it. */
    | { type: 'error_page'; reason: AuthorizeErrorReason }
    /** An error for the (now verified) redirect URI. */
    | { type: 'client_error'; location: string }
    | { type: 'consent'; requestId: string };

export type PendingRequestResult =
    | { status: 'ok'; authorization: OAuthAuthorizationEntity; client: OAuthClientEntity }
    | { status: 'not_found' }
    | { status: 'gone' };

export type DecisionResult = { status: 'ok'; redirectUrl: string } | { status: 'not_found' } | { status: 'gone' };

export type AccessTokenResult =
    | { ok: true; grantId: string; clientId: string; userId: string; scopes: string[] }
    | { ok: false; reason: 'invalid_token' | 'insufficient_scope' };

export interface IClientCredentials {
    /** The raw Authorization header, when it is a Basic credential. */
    basic?: { id: string; secret: string } | 'malformed';
    bodyClientId?: string;
    bodyClientSecret?: string;
}

export interface IConnectedAppRow {
    id: string;
    clientName: string;
    redirectUri: string;
    createdAt: Date;
    lastUsedAt: Date | null;
}

/**
 * The OAuth 2.1 authorization server: dynamic client registration, authorization requests, code and refresh grants, revocation and
 * access-token resolution. It has no knowledge of VCS providers or app access: the host supplies those through OAuthPolicy.
 * Every secret, code and token is stored only as a SHA-256 hash.
 */
export class OAuthServerService {
    constructor(
        private db: Db,
        private appConfig: AppConfig,
        private logger: ScopedLogger,
        private policy: OAuthPolicy
    ) {}

    /** The OAuth URLs, or null when OAuth is disabled or PUBLIC_URL is unsuitable as an issuer. */
    urls(): IOAuthUrls | null {
        return getOAuthUrls(this.appConfig);
    }

    // ------------------------------------------------------------------ clients

    async findClient(clientId: string | undefined): Promise<OAuthClientEntity | undefined> {
        if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) return undefined;
        return OAuthClientEntity.query().filter({ id: clientId.toLowerCase() }).findOneOrUndefined();
    }

    /** RFC 7591 registration. `metadata` is the parsed JSON body; anything unrecognised or unsafe is ignored or rejected. */
    async registerClient(metadata: unknown): Promise<IRegisteredClient> {
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
            throw new OAuthError('invalid_client_metadata', 'The registration body must be a JSON object.');
        }
        const meta = metadata as Record<string, unknown>;

        const uris = meta.redirect_uris;
        if (!Array.isArray(uris) || uris.length < 1 || uris.length > OAUTH_MAX_REDIRECT_URIS) {
            throw new OAuthError('invalid_redirect_uri', `redirect_uris must list 1 to ${OAUTH_MAX_REDIRECT_URIS} URIs.`);
        }
        if (!uris.every(u => typeof u === 'string' && isValidRedirectUri(u))) {
            throw new OAuthError('invalid_redirect_uri', 'Each redirect URI must be https, or http on a loopback host, without a fragment.');
        }
        const redirectUris = [...new Set(uris as string[])];

        let method: OAuthClientAuthMethod = 'client_secret_basic';
        if (meta.token_endpoint_auth_method !== undefined) {
            if (
                typeof meta.token_endpoint_auth_method !== 'string' ||
                !OAUTH_AUTH_METHODS.includes(meta.token_endpoint_auth_method as OAuthClientAuthMethod)
            ) {
                throw new OAuthError('invalid_client_metadata', 'Unsupported token_endpoint_auth_method.');
            }
            method = meta.token_endpoint_auth_method as OAuthClientAuthMethod;
        }
        const subsetOf = (value: unknown, allowed: string[]) =>
            value === undefined || (Array.isArray(value) && value.every(v => typeof v === 'string' && allowed.includes(v)));
        if (!subsetOf(meta.grant_types, ['authorization_code', 'refresh_token'])) {
            throw new OAuthError('invalid_client_metadata', 'Unsupported grant_types.');
        }
        if (!subsetOf(meta.response_types, ['code'])) {
            throw new OAuthError('invalid_client_metadata', 'Unsupported response_types.');
        }

        // logo_uri, client_uri, tos_uri, policy_uri and software_statement are deliberately ignored: never stored, echoed or fetched.
        const secret = method === 'none' ? undefined : generateToken(OAUTH_PREFIX_CLIENT_SECRET);
        const client = await createPersistedEntity(OAuthClientEntity, {
            id: uuid4(),
            name: sanitizeClientName(meta.client_name),
            redirectUris,
            tokenEndpointAuthMethod: method,
            secretHash: secret ? hashToken(secret) : null,
            createdAt: new Date(),
            lastUsedAt: null
        });
        return { client, clientSecret: secret };
    }

    /**
     * Authenticates the client of a token or revocation request. Throws invalid_client (401) on any failure, with a Basic challenge
     * when Basic was attempted. Secrets are compared as SHA-256 digests in constant time.
     */
    async authenticateClient(creds: IClientCredentials): Promise<OAuthClientEntity> {
        const basicAttempted = creds.basic !== undefined;
        const fail = (): never => {
            throw new OAuthError(
                'invalid_client',
                'Client authentication failed.',
                401,
                basicAttempted ? { 'WWW-Authenticate': 'Basic realm="PixelCI"' } : {}
            );
        };

        if (creds.basic === 'malformed') return fail();
        if (creds.basic && creds.bodyClientSecret !== undefined) {
            throw new OAuthError('invalid_request', 'Use one client authentication method.');
        }
        if (creds.basic && creds.bodyClientId !== undefined && creds.bodyClientId !== creds.basic.id) return fail();

        const clientId = creds.basic?.id ?? creds.bodyClientId;
        const secret = creds.basic ? creds.basic.secret : creds.bodyClientSecret;
        const client = await this.findClient(clientId);
        if (!client) return fail();

        if (client.tokenEndpointAuthMethod === 'none') {
            // A public client has no secret; one being presented means the caller is confused or probing.
            if (secret) return fail();
            return client;
        }
        if (!secret || !client.secretHash || !safeEqual(hashToken(secret), client.secretHash)) return fail();
        return client;
    }

    // ------------------------------------------------------------ authorization

    /**
     * Validates an authorization request and stores it as pending consent. Nothing is ever redirected to the client until its
     * client_id and redirect_uri have been verified; failures before that go to our own error page.
     */
    async startAuthorization(params: Record<string, string | string[] | undefined>, urls: IOAuthUrls): Promise<AuthorizeResult> {
        const q = new Map<string, string[]>();
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined) q.set(key, Array.isArray(value) ? value : [value]);
        }
        // `resource` may legitimately repeat (RFC 8707); anything else repeated is ambiguous.
        for (const [key, values] of q) if (key !== 'resource' && values.length > 1) return { type: 'error_page', reason: 'invalid_request' };
        const one = (name: string): string | undefined => q.get(name)?.[0];

        const client = await this.findClient(one('client_id'));
        if (!client) return { type: 'error_page', reason: 'invalid_client' };

        const redirectUri = one('redirect_uri');
        if (!redirectUri || !matchesAnyRedirectUri(client.redirectUris, redirectUri)) {
            return { type: 'error_page', reason: 'invalid_redirect_uri' };
        }

        // From here the redirect URI is trusted: errors go to the client.
        const rawState = one('state');
        const clientError = (error: string, description: string, withState = true): AuthorizeResult => ({
            type: 'client_error',
            location: buildRedirect(redirectUri, urls, { error, error_description: description }, withState ? rawState : undefined)
        });

        if (rawState !== undefined && rawState.length > OAUTH_MAX_STATE_LENGTH) {
            return clientError('invalid_request', 'The state parameter is too long.', false);
        }
        if (one('response_type') !== 'code') return clientError('unsupported_response_type', 'Only response_type=code is supported.');

        const challenge = one('code_challenge');
        if (!challenge || !PKCE_CHALLENGE_RE.test(challenge) || one('code_challenge_method') !== 'S256') {
            return clientError('invalid_request', 'PKCE with the S256 code challenge method is required.');
        }

        const resource = normalizeResource(q.get('resource') ?? [], urls);
        if (!resource) return clientError('invalid_target', 'The resource is not served by this authorization server.');

        const now = Date.now();
        const authorization = await createPersistedEntity(OAuthAuthorizationEntity, {
            id: uuid4(),
            clientId: client.id,
            userId: null,
            redirectUri,
            state: rawState ?? null,
            codeChallenge: challenge,
            scope: OAUTH_SCOPE, // unknown requested scopes are ignored; the only scope there is gets granted
            resource,
            status: 'pending',
            codeHash: null,
            grantId: null,
            createdAt: new Date(now),
            expiresAt: new Date(now + OAUTH_PENDING_REQUEST_TTL_MS),
            approvedAt: null,
            redeemedAt: null
        });
        return { type: 'consent', requestId: authorization.id };
    }

    /** A pending request as the consent screen sees it. */
    async getPendingRequest(requestId: string): Promise<PendingRequestResult> {
        if (!UUID_RE.test(requestId)) return { status: 'not_found' };
        const authorization = await OAuthAuthorizationEntity.query().filter({ id: requestId.toLowerCase() }).findOneOrUndefined();
        if (!authorization) return { status: 'not_found' };
        const client = await OAuthClientEntity.query().filter({ id: authorization.clientId }).findOneOrUndefined();
        if (!client) return { status: 'not_found' };
        if (authorization.status !== 'pending' || authorization.expiresAt.getTime() <= Date.now()) return { status: 'gone' };
        return { status: 'ok', authorization, client };
    }

    /** Approves a pending request for `userId`: single-use, compare-and-set. Returns the client redirect carrying the code. */
    async approve(requestId: string, userId: string, urls: IOAuthUrls): Promise<DecisionResult> {
        const pending = await this.getPendingRequest(requestId);
        if (pending.status !== 'ok') return pending;
        const { authorization } = pending;

        const code = generateToken(OAUTH_PREFIX_CODE);
        const now = Date.now();
        const claimed = await OAuthAuthorizationEntity.query()
            .filter({ id: authorization.id, status: 'pending', expiresAt: { $gt: new Date(now) } })
            .patchOne({
                status: 'approved',
                userId,
                codeHash: hashToken(code),
                approvedAt: new Date(now),
                expiresAt: new Date(now + OAUTH_CODE_TTL_MS)
            });
        if (!claimed.affectedRows) return this.decisionLost(authorization.id);

        return { status: 'ok', redirectUrl: buildRedirect(authorization.redirectUri, urls, { code }, authorization.state ?? undefined) };
    }

    /** Denies a pending request. Same compare-and-set as approve; returns the client redirect carrying `access_denied`. */
    async deny(requestId: string, userId: string, urls: IOAuthUrls): Promise<DecisionResult> {
        const pending = await this.getPendingRequest(requestId);
        if (pending.status !== 'ok') return pending;
        const { authorization } = pending;

        const claimed = await OAuthAuthorizationEntity.query()
            .filter({ id: authorization.id, status: 'pending', expiresAt: { $gt: new Date() } })
            .patchOne({ status: 'denied', userId });
        if (!claimed.affectedRows) return this.decisionLost(authorization.id);

        return {
            status: 'ok',
            redirectUrl: buildRedirect(
                authorization.redirectUri,
                urls,
                { error: 'access_denied', error_description: 'The user denied the request.' },
                authorization.state ?? undefined
            )
        };
    }

    private async decisionLost(requestId: string): Promise<DecisionResult> {
        const row = await OAuthAuthorizationEntity.query().filter({ id: requestId }).findOneOrUndefined();
        return { status: row ? 'gone' : 'not_found' };
    }

    // ------------------------------------------------------------------- tokens

    /**
     * Redeems an authorization code. The code is claimed with a compare-and-set before anything is validated, so every code gets
     * exactly one attempt: a wrong verifier burns it. Presenting an already-redeemed code revokes the grant it produced.
     */
    async exchangeAuthorizationCode(
        client: OAuthClientEntity,
        p: { code: string; redirectUri: string; codeVerifier: string; resource: string[] },
        urls: IOAuthUrls
    ): Promise<ITokenResponse> {
        const invalidGrant = () => new OAuthError('invalid_grant', 'The authorization code is invalid, expired or already used.');
        if (!PKCE_VERIFIER_RE.test(p.codeVerifier)) throw new OAuthError('invalid_request', 'The code_verifier is malformed.');
        if (!p.code.startsWith(OAUTH_PREFIX_CODE)) throw invalidGrant();

        const codeHash = hashToken(p.code);
        const row = await OAuthAuthorizationEntity.query().filter({ codeHash }).findOneOrUndefined();
        if (!row || (row.status !== 'approved' && row.status !== 'redeemed')) throw invalidGrant();
        if (row.status === 'redeemed') {
            await this.handleCodeReplay(row.grantId);
            throw invalidGrant();
        }

        const now = new Date();
        type Outcome = { kind: 'lost' } | { kind: 'invalid'; error: OAuthError } | { kind: 'ok'; tokens: ITokenResponse };
        const outcome = await this.db.transaction(async (txn): Promise<Outcome> => {
            const claimed = await txn
                .query(OAuthAuthorizationEntity)
                .filter({ id: row.id, status: 'approved' })
                .patchOne({ status: 'redeemed', redeemedAt: now });
            if (!claimed.affectedRows) return { kind: 'lost' };

            // Returned (not thrown), so the burn commits even though the exchange fails.
            if (row.clientId !== client.id || row.redirectUri !== p.redirectUri || row.expiresAt.getTime() <= now.getTime()) {
                return { kind: 'invalid', error: invalidGrant() };
            }
            if (!verifyPkce(p.codeVerifier, row.codeChallenge)) return { kind: 'invalid', error: invalidGrant() };
            if (normalizeResource(p.resource, urls) !== row.resource) {
                return { kind: 'invalid', error: new OAuthError('invalid_target', 'The resource does not match the authorization request.') };
            }
            if (!row.userId) return { kind: 'invalid', error: invalidGrant() };

            const grant = await createPersistedEntity(
                OAuthGrantEntity,
                {
                    id: uuid4(),
                    clientId: client.id,
                    userId: row.userId,
                    scope: row.scope,
                    resource: row.resource,
                    redirectUri: row.redirectUri,
                    createdAt: now,
                    expiresAt: new Date(now.getTime() + OAUTH_GRANT_TTL_MS),
                    lastUsedAt: null,
                    revokedAt: null,
                    revokedReason: null
                },
                txn
            );

            // One live connection per user and client: a fresh authorization replaces the earlier one.
            const superseded = await txn
                .query(OAuthGrantEntity)
                .filter({ userId: row.userId, clientId: client.id, revokedAt: null, id: { $ne: grant.id } })
                .patchMany({ revokedAt: now, revokedReason: 'superseded' });
            if (superseded.primaryKeys.length) {
                await txn
                    .query(OAuthTokenEntity)
                    .filter({ grantId: { $in: superseded.primaryKeys.map(k => String(k.id)) } })
                    .deleteMany();
            }

            const tokens = await this.issueTokens(txn, grant, now);
            await txn.query(OAuthAuthorizationEntity).filter({ id: row.id }).patchOne({ grantId: grant.id });
            await txn.query(OAuthClientEntity).filter({ id: client.id }).patchOne({ lastUsedAt: now });
            return { kind: 'ok', tokens };
        });

        if (outcome.kind === 'lost') {
            // A concurrent redemption won. Whatever it issued is now suspect: revoke it.
            const winner = await OAuthAuthorizationEntity.query().filter({ id: row.id }).findOneOrUndefined();
            await this.handleCodeReplay(winner?.grantId ?? null);
            throw invalidGrant();
        }
        if (outcome.kind === 'invalid') {
            this.logger.warn('OAuth code redemption rejected', { clientId: client.id, error: outcome.error.code });
            throw outcome.error;
        }
        return outcome.tokens;
    }

    private async handleCodeReplay(grantId: string | null): Promise<void> {
        if (!grantId) return;
        this.logger.warn('OAuth authorization code replayed; revoking its grant', { grantId });
        await this.revokeGrant(grantId, 'code_reuse');
    }

    /** Refresh-token grant with rotation. A rotated token presented again after a short leeway revokes the whole grant. */
    async refreshTokens(
        client: OAuthClientEntity,
        p: { refreshToken: string; scope?: string; resource: string[] },
        urls: IOAuthUrls
    ): Promise<ITokenResponse> {
        const invalidGrant = () => new OAuthError('invalid_grant', 'The refresh token is invalid, expired or revoked.');
        if (!p.refreshToken.startsWith(OAUTH_PREFIX_REFRESH)) throw invalidGrant();

        const tokenRow = await OAuthTokenEntity.query()
            .filter({ tokenHash: hashToken(p.refreshToken), kind: 'refresh' })
            .findOneOrUndefined();
        const now = new Date();
        if (!tokenRow || tokenRow.expiresAt.getTime() <= now.getTime()) throw invalidGrant();
        const grant = await OAuthGrantEntity.query().filter({ id: tokenRow.grantId }).findOneOrUndefined();
        if (!grant || grant.revokedAt || grant.expiresAt.getTime() <= now.getTime() || grant.clientId !== client.id) throw invalidGrant();

        if (p.scope !== undefined) {
            const granted = grant.scope.split(' ');
            const asked = p.scope.split(' ').filter(Boolean);
            if (!asked.length || !asked.every(s => granted.includes(s)))
                throw new OAuthError('invalid_scope', 'The scope exceeds the original grant.');
        }
        if (p.resource.length && normalizeResource(p.resource, urls) !== grant.resource) {
            throw new OAuthError('invalid_target', 'The resource does not match the original grant.');
        }

        // Network I/O (the provider session check) stays outside the transaction.
        let session = await this.policy.checkSession(grant.userId);
        if (session === 'reauth') {
            // Another replica may be mid-refresh of the same provider session (single-use refresh tokens make the loser see
            // invalid_grant). Check once more before revoking the grant for good.
            await new Promise(resolve => setTimeout(resolve, 250));
            session = await this.policy.checkSession(grant.userId);
        }
        if (session === 'reauth') {
            await this.revokeGrant(grant.id, 'vcs_session');
            throw new OAuthError('invalid_grant', 'Your sign-in has expired. Reconnect PixelCI.');
        }

        type Outcome = { kind: 'invalid' } | { kind: 'reuse' } | { kind: 'ok'; tokens: ITokenResponse };
        const outcome = await this.db.transaction(async (txn): Promise<Outcome> => {
            // Lock order is grant, then token, matching revokeGrant.
            const lockedGrant = await txn.query(OAuthGrantEntity).filter({ id: grant.id }).forUpdate().findOneOrUndefined();
            if (!lockedGrant || lockedGrant.revokedAt || lockedGrant.expiresAt.getTime() <= now.getTime()) return { kind: 'invalid' };
            const locked = await txn.query(OAuthTokenEntity).filter({ id: tokenRow.id }).forUpdate().findOneOrUndefined();
            if (!locked || locked.expiresAt.getTime() <= now.getTime()) return { kind: 'invalid' };

            if (locked.rotatedAt === null) {
                await txn.query(OAuthTokenEntity).filter({ id: locked.id }).patchOne({ rotatedAt: now });
            } else if (now.getTime() - locked.rotatedAt.getTime() > OAUTH_REFRESH_REUSE_LEEWAY_MS) {
                return { kind: 'reuse' };
            } else {
                // Within the leeway: a client retrying after a lost response gets a fresh pair. Every refresh token issued since
                // (the earlier rotation's) is marked rotated past the leeway, so the branch that loses can't keep refreshing:
                // presenting it later counts as reuse and revokes the grant. Without this, a stolen token presented within the
                // leeway would fork the grant into two independent, undetectable token chains.
                await txn
                    .query(OAuthTokenEntity)
                    .filter({ grantId: lockedGrant.id, kind: 'refresh', rotatedAt: null })
                    .patchMany({ rotatedAt: new Date(now.getTime() - OAUTH_REFRESH_REUSE_LEEWAY_MS - 1000) });
            }

            const tokens = await this.issueTokens(txn, lockedGrant, now);
            await txn.query(OAuthClientEntity).filter({ id: client.id }).patchOne({ lastUsedAt: now });
            return { kind: 'ok', tokens };
        });

        if (outcome.kind === 'reuse') {
            // Separate transaction: the revocation must commit although this call fails.
            this.logger.warn('OAuth refresh token reuse detected; revoking its grant', { grantId: grant.id, clientId: client.id });
            await this.revokeGrant(grant.id, 'refresh_reuse');
            throw invalidGrant();
        }
        if (outcome.kind === 'invalid') throw invalidGrant();
        return outcome.tokens;
    }

    /** RFC 7009. A refresh token revokes its whole grant, an access token only itself. Foreign and unknown tokens are ignored. */
    async revokeToken(client: OAuthClientEntity, token: string): Promise<void> {
        if (!token.startsWith(OAUTH_PREFIX_ACCESS) && !token.startsWith(OAUTH_PREFIX_REFRESH)) return;
        const row = await OAuthTokenEntity.query()
            .filter({ tokenHash: hashToken(token) })
            .findOneOrUndefined();
        if (!row) return;
        const grant = await OAuthGrantEntity.query().filter({ id: row.grantId }).findOneOrUndefined();
        if (!grant || grant.clientId !== client.id) return;
        if (row.kind === 'refresh') await this.revokeGrant(grant.id, 'client_revoke');
        else await OAuthTokenEntity.query().filter({ id: row.id }).deleteMany();
    }

    /**
     * Revokes a grant and deletes its tokens in one transaction. The grant row is patched first (taking its lock), which serializes
     * with a refresh that holds the same lock. Idempotent; the first reason sticks.
     */
    async revokeGrant(grantId: string, reason: OAuthRevokedReason): Promise<void> {
        await this.db.transaction(async txn => {
            await txn.query(OAuthGrantEntity).filter({ id: grantId, revokedAt: null }).patchOne({ revokedAt: new Date(), revokedReason: reason });
            await txn.query(OAuthTokenEntity).filter({ grantId }).deleteMany();
        });
    }

    private async issueTokens(
        txn: Parameters<Parameters<Db['transaction']>[0]>[0],
        grant: Pick<OAuthGrantEntity, 'id' | 'scope' | 'expiresAt'>,
        now: Date
    ): Promise<ITokenResponse> {
        const accessToken = generateToken(OAUTH_PREFIX_ACCESS);
        const refreshToken = generateToken(OAUTH_PREFIX_REFRESH);
        const cap = grant.expiresAt.getTime();
        const accessExpires = Math.min(now.getTime() + OAUTH_ACCESS_TOKEN_TTL_MS, cap);
        await createPersistedEntity(
            OAuthTokenEntity,
            {
                id: uuid4(),
                grantId: grant.id,
                kind: 'access',
                tokenHash: hashToken(accessToken),
                createdAt: now,
                expiresAt: new Date(accessExpires),
                rotatedAt: null
            },
            txn
        );
        await createPersistedEntity(
            OAuthTokenEntity,
            {
                id: uuid4(),
                grantId: grant.id,
                kind: 'refresh',
                tokenHash: hashToken(refreshToken),
                createdAt: now,
                expiresAt: new Date(Math.min(now.getTime() + OAUTH_REFRESH_TOKEN_TTL_MS, cap)),
                rotatedAt: null
            },
            txn
        );
        return {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: Math.max(1, Math.floor((accessExpires - now.getTime()) / 1000)),
            refresh_token: refreshToken,
            scope: grant.scope
        };
    }

    // ------------------------------------------------------- resolving a bearer

    /**
     * Resolves an access token presented to the protected resource. Requires an unexpired access token of a live grant that is bound to
     * this deployment's MCP resource (audience binding) and carries the mcp:read scope.
     */
    async resolveAccessToken(token: string): Promise<AccessTokenResult> {
        const urls = this.urls();
        if (!urls || !token.startsWith(OAUTH_PREFIX_ACCESS)) return { ok: false, reason: 'invalid_token' };

        const now = new Date();
        const row = await OAuthTokenEntity.query()
            .filter({ tokenHash: hashToken(token), kind: 'access', expiresAt: { $gt: now } })
            .findOneOrUndefined();
        if (!row) return { ok: false, reason: 'invalid_token' };
        const grant = await OAuthGrantEntity.query().filter({ id: row.grantId }).findOneOrUndefined();
        if (!grant || grant.revokedAt || grant.expiresAt.getTime() <= now.getTime() || grant.resource !== urls.resource) {
            return { ok: false, reason: 'invalid_token' };
        }
        const scopes = grant.scope.split(' ');
        if (!scopes.includes(OAUTH_SCOPE)) return { ok: false, reason: 'insufficient_scope' };

        this.touchGrant(grant, now);
        return { ok: true, grantId: grant.id, clientId: grant.clientId, userId: grant.userId, scopes };
    }

    /** Fire-and-forget, throttled bump of the grant's last-used time. */
    private touchGrant(grant: OAuthGrantEntity, now: Date): void {
        if (grant.lastUsedAt && now.getTime() - grant.lastUsedAt.getTime() < OAUTH_LAST_USED_THROTTLE_MS) return;
        OAuthGrantEntity.query()
            .filter({ id: grant.id })
            .patchOne({ lastUsedAt: now })
            .catch(err => this.logger.warn('Failed to update OAuth grant lastUsedAt', { grantId: grant.id, error: String(err) }));
    }

    // ---------------------------------------------------------- connected apps

    /** The user's live grants (one per connected app), newest first. */
    async listGrantsForUser(userId: string): Promise<IConnectedAppRow[]> {
        const grants = await OAuthGrantEntity.query()
            .filter({ userId, revokedAt: null, expiresAt: { $gt: new Date() } })
            .orderBy('createdAt', 'desc')
            .find();
        if (!grants.length) return [];
        const clients = await OAuthClientEntity.query()
            .filter({ id: { $in: [...new Set(grants.map(g => g.clientId))] } })
            .find();
        const names = new Map(clients.map(c => [c.id, c.name]));
        return grants.map(g => ({
            id: g.id,
            clientName: names.get(g.clientId) ?? OAUTH_DEFAULT_CLIENT_NAME,
            redirectUri: g.redirectUri,
            createdAt: g.createdAt,
            lastUsedAt: g.lastUsedAt
        }));
    }

    /** Revokes one of the user's own grants. False when there is no such live grant (also for another user's). */
    async revokeGrantForUser(userId: string, grantId: string): Promise<boolean> {
        if (!UUID_RE.test(grantId)) return false;
        const grant = await OAuthGrantEntity.query().filter({ id: grantId.toLowerCase(), userId, revokedAt: null }).findOneOrUndefined();
        if (!grant) return false;
        await this.revokeGrant(grant.id, 'user');
        return true;
    }
}

/** A client name safe to display: control, bidi and zero-width characters removed, whitespace collapsed, capped. */
export function sanitizeClientName(value: unknown): string {
    if (typeof value !== 'string') return OAUTH_DEFAULT_CLIENT_NAME;
    const cleaned = value.replace(/\s+/g, ' ').replace(NAME_STRIP_RE, '').trim();
    const capped = Array.from(cleaned).slice(0, OAUTH_MAX_CLIENT_NAME_LENGTH).join('').trim();
    return capped || OAUTH_DEFAULT_CLIENT_NAME;
}

/** Appends parameters (and `iss`, RFC 9207) to a verified redirect URI using URL, never string concatenation. */
export function buildRedirect(redirectUri: string, urls: Pick<IOAuthUrls, 'issuer'>, params: Record<string, string>, state?: string): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (state !== undefined) url.searchParams.set('state', state);
    url.searchParams.set('iss', urls.issuer);
    return url.toString();
}
