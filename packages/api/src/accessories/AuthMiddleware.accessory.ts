import { HttpRequest, HttpUnauthorizedError } from '@zyno-io/ts-server-foundation';
import { Logger } from '@zyno-io/ts-server-foundation';
import { createAuthMiddleware, HttpAccessDeniedError, HttpMiddleware } from '@zyno-io/ts-server-foundation';
import { createHash } from 'crypto';

import { BuildEntity } from '../entities/Build.entity';
import { UserEntity } from '../entities/User.entity';
import { VcsIntegrationEntity } from '../entities/VcsIntegration.entity';
import { BoundedTtlCache } from '../helpers/BoundedTtlCache';
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
        const allowed =
            !!build && (build.ciTokenHash === tokenHash || (request.method === 'GET' && (build.ciReadTokenHashes ?? []).includes(tokenHash)));
        if (!build || !allowed) {
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

/**
 * Middleware for read-only programmatic access (e.g. the MCP server) authenticated with a VCS
 * personal access token. Verifies the Bearer token against the VCS provider, confirms it
 * maps to a known PixelCI user, and records the resolved auth context on the request.
 */
export class VcsTokenAuthMiddleware extends HttpMiddleware {
    constructor(
        private logger: Logger,
        private vcsService: VcsService
    ) {
        super();
    }

    async handle(request: HttpRequest) {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            this.logger.warn('VCS token auth failed: missing or malformed Authorization header');
            throw new HttpUnauthorizedError();
        }

        const token = authHeader.slice(7).trim();
        if (!token || /\s/.test(token)) {
            this.logger.warn('VCS token auth failed: empty or malformed bearer token');
            throw new HttpUnauthorizedError();
        }
        const requestedVcsId = (request.headers['x-pixelci-vcs-id'] as string | undefined)?.trim() || undefined;

        const { user, vcsId } = await resolveUserFromVcsToken(token, requestedVcsId, this.logger, this.vcsService);
        vcsAuthContextByRequest.set(request, { token, vcsId, userId: user.id });
    }
}
