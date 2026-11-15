import { HttpRequest, HttpUnauthorizedError } from '@zyno-io/ts-server-foundation';
import { Logger } from '@zyno-io/ts-server-foundation';
import { createAuthMiddleware, HttpAccessDeniedError, HttpMiddleware } from '@zyno-io/ts-server-foundation';
import { createHash } from 'crypto';

import { AppConfig } from '../config';
import { BuildEntity } from '../entities/Build.entity';
import { BuildShardEntity } from '../entities/BuildShard.entity';
import { UserEntity } from '../entities/User.entity';
import { VcsIntegrationEntity } from '../entities/VcsIntegration.entity';
import { BoundedTtlCache } from '../helpers/BoundedTtlCache';
import { IAppAccessPrincipal } from '../services/AppAccess.service';
import { OAUTH_PREFIX_ACCESS, OAUTH_PREFIX_ANY } from '../services/oauth/OAuthConstants';
import { bearerErrorResponse, parseBearer } from '../services/oauth/OAuthErrors';
import { OAuthServerService } from '../services/oauth/OAuthServer.service';
import { VcsService } from '../services/Vcs.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * User authentication
 */
export class UserAuthMiddleware extends createAuthMiddleware(UserEntity) {}
export class AdminAuthMiddleware extends UserAuthMiddleware {
    async validateEntity(_request: HttpRequest, entity: UserEntity) {
        if (!entity.isAdmin) throw new HttpAccessDeniedError('Insufficient permissions');
    }
}

/** CI session tokens (uploader and readers) stop working this long after the last create/upload, so final-status polls can be repeated safely. */
export const CI_TOKEN_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * Hashes a CI token for storage/comparison.
 */
export function hashCiToken(ciToken: string): string {
    return createHash('sha256').update(ciToken).digest('hex');
}

/**
 * Middleware for build-level CI token authentication.
 * Verifies that the Bearer token's SHA-256 hash matches the build's ciTokenHash (or, for GET, ciReadTokenHashes).
 * Used on upload, process, and getBuildStatus endpoints.
 */
export class BuildCiTokenMiddleware extends HttpMiddleware {
    constructor(private logger: Logger) {
        super();
    }

    async handle(request: HttpRequest) {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            this.logger.warn('CI token auth failed: missing or malformed Authorization header');
            throw new HttpUnauthorizedError();
        }

        const ciToken = authHeader.slice(7);
        const tokenHash = hashCiToken(ciToken);

        const match = request.url?.match(/^\/api\/apps\/[^/]+\/builds\/([^/]+)/);
        if (!match) {
            this.logger.warn('CI token auth failed: could not extract buildId from URL');
            throw new HttpUnauthorizedError();
        }
        const buildId = match[1];
        if (!UUID_RE.test(buildId)) {
            this.logger.warn('CI token auth failed: malformed buildId in URL');
            throw new HttpUnauthorizedError();
        }

        const build = await BuildEntity.query().filter({ id: buildId }).findOneOrUndefined();
        // Uploads/process require the creator's token; status polling also accepts read-only tokens of concurrent jobs
        let allowed =
            !!build && (build.ciTokenHash === tokenHash || (request.method === 'GET' && (build.ciReadTokenHashes ?? []).includes(tokenHash)));
        // A sharded build has no single uploader: each shard's job holds its own token (for uploads, process and status polling)
        if (build && !allowed && build.shardTotal > 1) {
            allowed = !!(await BuildShardEntity.query().filter({ buildId: build.id, ciTokenHash: tokenHash }).findOneOrUndefined());
        }
        // Sessions expire (refreshed on create/upload). A null expiry is a build created by an old pod during the rolling deploy (the column
        // is added before the old pods stop and has no default), so fall back to the build's last activity plus the TTL.
        const expiresAt = build && (build.ciTokensExpireAt ?? new Date((build.draftActiveAt ?? build.createdAt).getTime() + CI_TOKEN_TTL_MS));
        const expired = !expiresAt || expiresAt.getTime() <= Date.now();
        if (!build || !allowed || expired) {
            this.logger.warn(`CI token auth failed: build not found or token hash mismatch for buildId=${buildId}`);
            throw new HttpUnauthorizedError();
        }
    }
}

/**
 * Resolves a PixelCI user from a VCS personal access token, together with the provider the
 * token belongs to. The token is only ever sent to a SINGLE provider: the one named by
 * `requestedVcsId`, or else the sole configured integration of the platform inferred from the token's
 * prefix. If multiple such integrations exist and no id is given we refuse, rather than fan the token out
 * across providers. Successful lookups are briefly cached.
 */
const VCS_TOKEN_CACHE_TTL_MS = 60_000;
const vcsTokenUserCache = new BoundedTtlCache<{ userId: string; vcsId: string }>(1_000, VCS_TOKEN_CACHE_TTL_MS);

/** GitHub token prefixes (classic/fine-grained PATs, OAuth, user-to-server, server-to-server, refresh); everything else is GitLab. */
export function inferTokenPlatform(token: string): VcsIntegrationEntity['platform'] {
    return /^(gh[pousr]_|github_pat_)/.test(token) ? 'github' : 'gitlab';
}

export interface IVcsAuthContext {
    token: string;
    vcsId: string;
    userId: string;
}

const vcsAuthContextByRequest = new WeakMap<HttpRequest, IVcsAuthContext>();

export function getVcsAuthContext(request: HttpRequest): IVcsAuthContext | undefined {
    return vcsAuthContextByRequest.get(request);
}

/** The access principal for a request that passed VcsTokenAuthMiddleware. */
export function vcsPrincipal(request: HttpRequest): IAppAccessPrincipal {
    const ctx = getVcsAuthContext(request);
    if (!ctx) throw new HttpUnauthorizedError();
    return { kind: 'token', token: ctx.token, vcsId: ctx.vcsId };
}

export async function resolveUserFromVcsToken(
    vcsToken: string,
    requestedVcsId: string | undefined,
    logger: Logger,
    vcsService: VcsService
): Promise<{ user: UserEntity; vcsId: string }> {
    const tokenHash = createHash('sha256').update(vcsToken).digest('hex');
    if (requestedVcsId && !UUID_RE.test(requestedVcsId)) {
        logger.warn('VCS token auth failed: malformed X-PixelCI-Vcs-Id header');
        throw new HttpUnauthorizedError();
    }

    const cacheKey = `${tokenHash}:${requestedVcsId ?? ''}`;

    const cached = vcsTokenUserCache.get(cacheKey);
    if (cached) {
        const cachedUser = await UserEntity.query().filter({ id: cached.userId }).findOneOrUndefined();
        if (cachedUser) return { user: cachedUser, vcsId: cached.vcsId };
        vcsTokenUserCache.delete(cacheKey);
    }

    const inferredPlatform = inferTokenPlatform(vcsToken);

    let integration: VcsIntegrationEntity | undefined;
    if (requestedVcsId) {
        integration = await VcsIntegrationEntity.query().filter({ id: requestedVcsId }).findOneOrUndefined();
        if (!integration) {
            logger.warn(`VCS token auth failed: no integration with id ${requestedVcsId}`);
            throw new HttpUnauthorizedError();
        }
        // Never forward a token to a provider it evidently wasn't issued by (GitHub tokens are prefixed,
        // so anything unprefixed is treated as GitLab and is not sent to GitHub either).
        if (integration.platform !== inferredPlatform) {
            logger.warn(`VCS token auth failed: ${inferredPlatform}-style token supplied for a ${integration.platform} integration`);
            throw new HttpUnauthorizedError();
        }
    } else {
        const candidates = await VcsIntegrationEntity.query().filter({ platform: inferredPlatform }).find();
        if (candidates.length > 1) {
            logger.warn(`VCS token auth failed: multiple ${inferredPlatform} integrations configured but no provider id was specified`);
            throw new HttpUnauthorizedError('Multiple VCS providers are configured; specify one via the X-PixelCI-Vcs-Id header');
        }
        integration = candidates[0];
        if (!integration) throw new HttpUnauthorizedError();
    }

    const tokenUser = await vcsService.getTokenUser(integration, vcsToken);
    if (!tokenUser) throw new HttpUnauthorizedError();

    const user = await UserEntity.query().filter({ vcsId: integration.id, vcsUserId: tokenUser.id }).findOneOrUndefined();

    if (!user) {
        logger.warn(
            `VCS token validation: ${integration.platform} user ${tokenUser.id} has no matching PixelCI account on provider ${integration.id}`
        );
        throw new HttpUnauthorizedError();
    }

    vcsTokenUserCache.set(cacheKey, { userId: user.id, vcsId: integration.id });
    return { user, vcsId: integration.id };
}

const JWT_SHAPED_RE = /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/;

/**
 * Parses a VCS personal access token out of an Authorization header. A token that is evidently NOT a VCS PAT is rejected here,
 * before anything is sent to a provider: PixelCI-issued credentials (`pixelci_*`: OAuth tokens, codes, client secrets) and
 * JWT-shaped tokens (a UI session) must never be forwarded to a VCS as if they were PATs.
 */
export function parseVcsPatBearer(header: string | undefined): { token: string } | { rejected: 'missing' | 'pixelci' | 'jwt' } {
    const token = parseBearer(header);
    if (!token) return { rejected: 'missing' };
    if (token.startsWith(OAUTH_PREFIX_ANY)) return { rejected: 'pixelci' };
    if (JWT_SHAPED_RE.test(token)) return { rejected: 'jwt' };
    return { token };
}

/**
 * Middleware for read-only programmatic access (/api/ext) authenticated with a VCS personal access token. Verifies the Bearer
 * token against the VCS provider, confirms it maps to a known PixelCI user, and records the resolved auth context on the request.
 * PAT-only: OAuth access tokens are audience-bound to /api/mcp and are not accepted here.
 */
export class VcsTokenAuthMiddleware extends HttpMiddleware {
    constructor(
        private logger: Logger,
        private vcsService: VcsService
    ) {
        super();
    }

    async handle(request: HttpRequest) {
        const parsed = parseVcsPatBearer(request.headers.authorization);
        if ('rejected' in parsed) {
            this.logger.warn(
                `VCS token auth failed: ${parsed.rejected === 'missing' ? 'missing or malformed bearer token' : `${parsed.rejected} token is not a VCS token`}`
            );
            throw new HttpUnauthorizedError();
        }
        const token = parsed.token;
        const requestedVcsId = (request.headers['x-pixelci-vcs-id'] as string | undefined)?.trim() || undefined;

        const { user, vcsId } = await resolveUserFromVcsToken(token, requestedVcsId, this.logger, this.vcsService);
        vcsAuthContextByRequest.set(request, { token, vcsId, userId: user.id });
    }
}

export interface IMcpAuthContext {
    principal: IAppAccessPrincipal;
    via: 'oauth' | 'pat';
    grantId?: string;
}

const mcpAuthContextByRequest = new WeakMap<HttpRequest, IMcpAuthContext>();

/** The access principal for a request that passed McpAuthMiddleware. */
export function mcpPrincipal(request: HttpRequest): IAppAccessPrincipal {
    const ctx = mcpAuthContextByRequest.get(request);
    if (!ctx) throw new HttpUnauthorizedError();
    return ctx.principal;
}

export function getMcpAuthContext(request: HttpRequest): IMcpAuthContext | undefined {
    return mcpAuthContextByRequest.get(request);
}

/**
 * Authentication for the MCP endpoint: an OAuth access token issued by PixelCI (acting as the user), or a VCS personal access
 * token (acting as the token). Failures are returned (not thrown) so the 401/403 carries a `WWW-Authenticate` challenge pointing
 * at the protected-resource metadata, which is how MCP clients discover where to sign in. Never logs token material.
 */
export class McpAuthMiddleware extends HttpMiddleware {
    constructor(
        private logger: Logger,
        private vcsService: VcsService,
        private oauth: OAuthServerService,
        private appConfig: AppConfig
    ) {
        super();
    }

    async handle(request: HttpRequest) {
        const urls = this.oauth.urls();
        const invalidToken = (reason: string, description = 'The access token is invalid, expired or revoked.') => {
            this.logger.warn(`MCP auth failed: ${reason}`);
            return bearerErrorResponse(urls, 401, { error: 'invalid_token', description });
        };

        const token = parseBearer(request.headers.authorization);
        if (!token) {
            this.logger.warn('MCP auth failed: missing or non-bearer credentials');
            return bearerErrorResponse(urls, 401, { description: 'Authentication is required.' });
        }

        // PixelCI-issued credentials: only access tokens are meaningful here, and none of them is ever forwarded to a VCS.
        if (token.startsWith(OAUTH_PREFIX_ANY)) {
            if (!urls || !token.startsWith(OAUTH_PREFIX_ACCESS)) return invalidToken('pixelci token that is not a usable access token');
            const resolved = await this.oauth.resolveAccessToken(token);
            if (!resolved.ok) {
                if (resolved.reason === 'insufficient_scope') {
                    this.logger.warn('MCP auth failed: insufficient scope');
                    return bearerErrorResponse(urls, 403, { error: 'insufficient_scope', description: 'The access token lacks the required scope.' });
                }
                return invalidToken('oauth access token not accepted');
            }
            const user = await UserEntity.query().filter({ id: resolved.userId }).findOneOrUndefined();
            if (!user) return invalidToken(`user of grant ${resolved.grantId} no longer exists`);
            if (this.appConfig.ENFORCE_VCS_PROJECT_ACCESS) {
                // The grant lives only as long as the user's VCS sign-in: a dead one makes the client re-authorize in the browser.
                const session = await this.vcsService.checkUserSession(user);
                if (session === 'reauth') {
                    return invalidToken(`vcs session of grant ${resolved.grantId} expired`, 'Your sign-in has expired; reconnect PixelCI.');
                }
            }
            // X-PixelCI-Vcs-Id is ignored: the grant's user determines the provider.
            mcpAuthContextByRequest.set(request, { principal: { kind: 'user', user }, via: 'oauth', grantId: resolved.grantId });
            return;
        }

        if (JWT_SHAPED_RE.test(token)) return invalidToken('jwt-shaped token is not a VCS token');

        const requestedVcsId = (request.headers['x-pixelci-vcs-id'] as string | undefined)?.trim() || undefined;
        try {
            const { vcsId } = await resolveUserFromVcsToken(token, requestedVcsId, this.logger, this.vcsService);
            mcpAuthContextByRequest.set(request, { principal: { kind: 'token', token, vcsId }, via: 'pat' });
        } catch (err) {
            if (err instanceof HttpUnauthorizedError) return invalidToken('vcs token rejected', err.message || undefined);
            throw err;
        }
    }
}
