import { HttpNotFoundError } from '@zyno-io/ts-server-foundation';
import { HttpAccessDeniedError } from '@zyno-io/ts-server-foundation';
import { createHash } from 'crypto';

import { AppConfig } from '../config';
import { AppEntity, IApprovalMinRole } from '../entities/App.entity';
import { UserEntity } from '../entities/User.entity';
import { VcsIntegrationEntity } from '../entities/VcsIntegration.entity';
import { IVcsProjectRole, VcsService } from './Vcs.service';

/**
 * Who is asking for access. UI requests act as a logged-in user (we use their stored VCS OAuth
 * token); programmatic requests act as a raw VCS token (the caller's personal access token).
 */
export type IAppAccessPrincipal = { kind: 'user'; user: UserEntity } | { kind: 'token'; token: string; vcsId: string };

const ACCESS_CACHE_TTL_MS = 60_000;
const ROLE_CACHE_TTL_MS = 60_000;

const ROLE_RANK: Record<IVcsProjectRole, number> = { none: 0, read: 1, write: 2, maintain: 3 };
const ROLE_LABEL: Record<IApprovalMinRole, string> = { read: 'read', write: 'write', maintain: 'maintainer' };

/**
 * Authorizes access to an app based on whether the caller can access the app's project in the VCS
 * provider. "Can access" means the provider reports the project as readable with the caller's token.
 * Decisions are cached briefly per principal+project to avoid a VCS round-trip on every request.
 */
export class AppAccessService {
    private cache = new Map<string, { allowed: boolean; expiresAt: number }>();
    /** VCS roles, kept apart from the read-access cache (and `role:`-prefixed) so the two can never answer for each other. */
    private roleCache = new Map<string, { role: IVcsProjectRole; expiresAt: number }>();

    constructor(
        private vcsService: VcsService,
        private appConfig: AppConfig
    ) {}

    async canAccess(principal: IAppAccessPrincipal, app: AppEntity): Promise<boolean> {
        if (!this.appConfig.ENFORCE_VCS_PROJECT_ACCESS) return true;

        // Never send a caller's token to a provider it doesn't belong to: an app on a different VCS
        // provider than the principal is simply not accessible (and avoids cross-provider token leaks).
        const principalVcsId = principal.kind === 'user' ? principal.user.vcsId : principal.vcsId;
        if (app.vcsId !== principalVcsId) return false;

        const projectIdentifier = app.vcsProjectId != null ? String(app.vcsProjectId) : app.projectPath;
        const principalKey =
            principal.kind === 'user' ? `user:${principal.user.id}` : `token:${createHash('sha256').update(principal.token).digest('hex')}`;
        const cacheKey = `${principalKey}:${app.vcsId}:${projectIdentifier}`;

        const cached = this.cache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.allowed;

        let allowed: boolean;
        try {
            allowed =
                principal.kind === 'user'
                    ? await this.vcsService.userCanAccessProject(principal.user, app.vcsId, projectIdentifier)
                    : await this.vcsService.tokenCanAccessProject(principal.token, app.vcsId, projectIdentifier);
        } catch {
            // fail closed: any error resolving access is treated as no access
            allowed = false;
        }

        this.cache.set(cacheKey, { allowed, expiresAt: Date.now() + ACCESS_CACHE_TTL_MS });
        return allowed;
    }

    async assertCanAccess(principal: IAppAccessPrincipal, app: AppEntity): Promise<void> {
        if (await this.canAccess(principal, app)) return;

        // Signed in through a different provider than the app's: say so, since the fix is to sign in
        // with the other one. (Without this the UI can only show a generic "no access".)
        const principalVcsId = principal.kind === 'user' ? principal.user.vcsId : principal.vcsId;
        if (app.vcsId !== principalVcsId) {
            const integration = await VcsIntegrationEntity.query().filterField('id', app.vcsId).findOneOrUndefined();
            const provider = integration?.name ?? 'a different provider';
            throw new HttpAccessDeniedError(`This app is connected to ${provider}. Sign in with ${provider} to view it.`);
        }

        throw new HttpAccessDeniedError('You do not have access to this project in the VCS provider');
    }

    /**
     * Loads a non-deleted app and asserts the principal can access it. Returns the app so callers can
     * reuse it. Throws 404 if the app does not exist, 403 if the caller lacks VCS access.
     */
    async assertCanAccessAppId(principal: IAppAccessPrincipal, appId: string): Promise<AppEntity> {
        const app = await AppEntity.query().filter({ id: appId, deletedAt: null }).findOneOrUndefined();
        if (!app) throw new HttpNotFoundError();
        await this.assertCanAccess(principal, app);
        return app;
    }

    /**
     * Whether the user may review screens and approve builds of the app. Never throws; denies on any doubt.
     * Requires read access, then: PixelCI admins always; nobody else while VCS checks are off; otherwise a VCS
     * role at or above the app's `approvalMinRole`.
     */
    async canReview(user: UserEntity, app: AppEntity): Promise<boolean> {
        if (!(await this.canAccess({ kind: 'user', user }, app))) return false;
        if (user.isAdmin) return true;
        if (!this.appConfig.ENFORCE_VCS_PROJECT_ACCESS) return false;
        const minRole = app.approvalMinRole as IApprovalMinRole;
        const required = ROLE_RANK[minRole];
        if (required === undefined) return false; // unknown setting: fail closed
        // Read access was just confirmed, which is all a 'read' threshold asks for.
        if (minRole === 'read') return true;

        const role = await this.getRole(user, app);
        return role !== null && ROLE_RANK[role] >= required;
    }

    /**
     * Loads the app, applies the read gate (404/403), then asserts the user may review it (403). Returns the app.
     */
    async assertCanReviewAppId(user: UserEntity, appId: string): Promise<AppEntity> {
        const app = await this.assertCanAccessAppId({ kind: 'user', user }, appId);
        if (await this.canReview(user, app)) return app;

        if (!this.appConfig.ENFORCE_VCS_PROJECT_ACCESS) {
            throw new HttpAccessDeniedError('Only PixelCI admins can review builds while VCS access checks are disabled');
        }
        const label = ROLE_LABEL[app.approvalMinRole as IApprovalMinRole] ?? 'write';
        throw new HttpAccessDeniedError(`Reviewing this app's builds requires ${label} access to its project in the VCS provider`);
    }

    /** The user's VCS role on the app's project; null when it couldn't be determined (not cached, so a blip doesn't stick). */
    private async getRole(user: UserEntity, app: AppEntity): Promise<IVcsProjectRole | null> {
        const projectIdentifier = app.vcsProjectId != null ? String(app.vcsProjectId) : app.projectPath;
        const cacheKey = `role:user:${user.id}:${app.vcsId}:${projectIdentifier}`;

        const cached = this.roleCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.role;

        let role: IVcsProjectRole;
        try {
            role = await this.vcsService.getUserProjectRole(user, app.vcsId, projectIdentifier);
        } catch {
            return null;
        }
        if (ROLE_RANK[role] === undefined) return null;

        this.roleCache.set(cacheKey, { role, expiresAt: Date.now() + ROLE_CACHE_TTL_MS });
        return role;
    }

    async filterAccessible(principal: IAppAccessPrincipal, apps: AppEntity[]): Promise<AppEntity[]> {
        const results = await Promise.all(apps.map(async app => ((await this.canAccess(principal, app)) ? app : null)));
        return results.filter((app): app is AppEntity => app !== null);
    }
}
