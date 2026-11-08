import { HttpNotFoundError } from '@zyno-io/ts-server-foundation';
import { HttpAccessDeniedError } from '@zyno-io/ts-server-foundation';
import { createHash } from 'crypto';

import { AppConfig } from '../config';
import { AppEntity } from '../entities/App.entity';
import { UserEntity } from '../entities/User.entity';
import { VcsService } from './Vcs.service';

/**
 * Who is asking for access. UI requests act as a logged-in user (we use their stored VCS OAuth
 * token); programmatic requests act as a raw VCS token (the caller's personal access token).
 */
export type IAppAccessPrincipal = { kind: 'user'; user: UserEntity } | { kind: 'token'; token: string; vcsId: string };

const ACCESS_CACHE_TTL_MS = 60_000;

/**
 * Authorizes access to an app based on whether the caller can access the app's project in the VCS
 * provider. "Can access" means the provider reports the project as readable with the caller's token.
 * Decisions are cached briefly per principal+project to avoid a VCS round-trip on every request.
 */
export class AppAccessService {
    private cache = new Map<string, { allowed: boolean; expiresAt: number }>();

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
        if (!(await this.canAccess(principal, app))) {
            throw new HttpAccessDeniedError('You do not have access to this project in the VCS provider');
        }
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

    async filterAccessible(principal: IAppAccessPrincipal, apps: AppEntity[]): Promise<AppEntity[]> {
        const results = await Promise.all(apps.map(async app => ((await this.canAccess(principal, app)) ? app : null)));
        return results.filter((app): app is AppEntity => app !== null);
    }
}
