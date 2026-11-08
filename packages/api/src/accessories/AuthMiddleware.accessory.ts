import { HttpRequest, HttpUnauthorizedError } from '@zyno-io/ts-server-foundation';
import { Logger } from '@zyno-io/ts-server-foundation';
import { createAuthMiddleware, HttpAccessDeniedError, HttpMiddleware } from '@zyno-io/ts-server-foundation';
import { createHash } from 'crypto';

import { BuildEntity } from '../entities/Build.entity';
import { UserEntity } from '../entities/User.entity';
import { VcsIntegrationEntity } from '../entities/VcsIntegration.entity';
import { VcsService } from '../services/Vcs.service';

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
 * Verifies that the Bearer token's SHA-256 hash matches the build's stored ciTokenHash.
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

        const build = await BuildEntity.query().filter({ id: buildId }).findOneOrUndefined();
        if (!build || build.ciTokenHash !== tokenHash) {
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
const vcsTokenUserCache = new Map<string, { userId: string; vcsId: string; expiresAt: number }>();
const VCS_TOKEN_CACHE_TTL_MS = 60_000;

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
    const cacheKey = `${tokenHash}:${requestedVcsId ?? ''}`;

    const cached = vcsTokenUserCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
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
        if (integration.platform === 'gitlab' && inferredPlatform === 'github') {
            logger.warn('VCS token auth failed: GitHub-style token supplied for a GitLab integration');
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

    vcsTokenUserCache.set(cacheKey, { userId: user.id, vcsId: integration.id, expiresAt: Date.now() + VCS_TOKEN_CACHE_TTL_MS });
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

        const token = authHeader.slice(7);
        const requestedVcsId = (request.headers['x-pixelci-vcs-id'] as string | undefined)?.trim() || undefined;

        const { user, vcsId } = await resolveUserFromVcsToken(token, requestedVcsId, this.logger, this.vcsService);
        vcsAuthContextByRequest.set(request, { token, vcsId, userId: user.id });
    }
}
