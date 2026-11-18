import { HttpBadRequestError, HttpUnauthorizedError, ScopedLogger } from '@zyno-io/ts-server-foundation';

import { AppConfig } from '../config';
import { AppEntity } from '../entities/App.entity';
import { IUserVcsSession, UserEntity } from '../entities/User.entity';
import { IGitHubConfig, IGitLabConfig, VcsIntegrationEntity } from '../entities/VcsIntegration.entity';
import { SecretUnreadableError } from './secrets/SecretBox';
import { openIntegrationConfig } from './secrets/VcsSecrets';
import { VcsGitHubService } from './VcsGitHub.service';
import { gitlabIdTokenAudiences, VcsGitLabService } from './VcsGitLab.service';
import { isVcsSessionFresh, VcsSessionExpiredError } from './VcsSessionRefresh';

export interface IVcsLoginSessionResponse extends IUserVcsSession {
    id: string;
    name: string;
}

export interface IVcsProject {
    id: string;
    name: string;
    projectPath: string;
    webUrl: string;
    description: string;
    defaultBranch?: string;
}

/**
 * Data extracted from the CI provider during token validation.
 */
export interface ICiJobData {
    jobId: string;
    branch: string;
    commitHash: string;
    commitSubject: string;
    commitAuthor: string;
    vcsProjectId: number;
}

/**
 * `deferred: true`: the provider can't re-run right now because the pipeline/run is still in progress; the caller should
 * retry later (`runAttempt` identifies the run attempt that was in progress). `superseded: true`: the run was re-run by someone
 * else since `expectedRunAttempt`, so nothing was done. `retryable: true` marks transient failures (5xx, network, timeouts).
 * Only the GitHub provider produces deferred/superseded/retryable (GitLab can retry a job mid-pipeline).
 */
export type IVcsRerunResult =
    | { ok: true; url: string; movedProjectPath?: string }
    | {
          ok: false;
          deferred?: false;
          superseded?: false;
          retryable?: boolean;
          url?: undefined;
          runAttempt?: undefined;
          error: string;
          movedProjectPath?: string;
      }
    | { ok: false; deferred: true; superseded?: false; retryable?: false; url: string; error: string; runAttempt?: number; movedProjectPath?: string }
    | { ok: false; superseded: true; deferred?: false; retryable?: false; error: string; movedProjectPath?: string };

export interface IVcsRerunOptions {
    /** Skip the re-run (result `superseded`) if the run's current attempt differs. */
    expectedRunAttempt?: number;
}

export interface IVcsTokenUser {
    id: string;
}

/**
 * Display-only commit details the CLI sends when the CI token (a GitLab ID token) carries none. Providers that read
 * commit metadata themselves ignore them.
 */
export interface ICiCommitHints {
    subject?: string;
    author?: string;
    /** From CI_MERGE_REQUEST_IID / CI_MERGE_REQUEST_EVENT_TYPE; used only for merge request pipelines, which GitLab records on a pseudo-ref. */
    mergeRequest?: { iid?: string; eventType?: string };
}

/** A user's role on a project, coarsened across providers. Ordered: none < read < write < maintain. */
export type IVcsProjectRole = 'none' | 'read' | 'write' | 'maintain';

export interface IVcsServiceImpl {
    /**
     * `expectedProjectId` is the app's bound project; providers that make further outbound calls after verifying
     * the token (e.g. GitHub commit metadata) must reject a mismatch before doing so. VcsService re-checks binding.
     */
    validateCiToken(ciToken: string, expectedProjectId: number, hints?: ICiCommitHints): Promise<ICiJobData>;
    getProviderLoginUrl(redirectUri: string, state?: string): Promise<string>;
    exchangeProviderCode(redirectUri: string, code: string): Promise<IVcsLoginSessionResponse>;
    rerunCiJob(
        user: UserEntity,
        app: Pick<AppEntity, 'projectPath' | 'vcsProjectId'>,
        ciJobId: string,
        options?: IVcsRerunOptions
    ): Promise<IVcsRerunResult>;
    /**
     * The distinct CI re-run targets for the CI job ids of a sharded build's jobs (one re-run request per target).
     * GitLab retries each job; GitHub can only re-run per workflow run, so job ids collapse to their run id.
     */
    rerunTargets(ciJobIds: string[]): string[];
    searchProjects(user: UserEntity, search: string): Promise<IVcsProject[]>;
    getProjectByPath(user: UserEntity, projectPath: string): Promise<IVcsProject>;
    /** Extracts the project path from a pasted repository URL; null when the URL doesn't belong to this provider. */
    parseProjectUrl(url: URL): string | null;
    getCommitUrlBase(projectPath: string): string;
    userCanAccessProject(user: UserEntity, projectIdentifier: string): Promise<boolean>;
    tokenCanAccessProject(token: string, projectIdentifier: string): Promise<boolean>;
    /**
     * The user's role on the project. Resolves 'none' when the provider definitively refuses (no session, 401/403/404);
     * throws on transient failures (network, 5xx) so the caller can deny without caching the result.
     */
    getUserProjectRole(user: UserEntity, projectIdentifier: string): Promise<IVcsProjectRole>;
    /** Resolves the provider user a personal access token belongs to; null if the token is invalid. */
    getTokenUser(token: string): Promise<IVcsTokenUser | null>;
    /** Refreshes the user's stored session if it is expired or about to be. Throws VcsSessionExpiredError when it can't be recovered. */
    ensureUserSession(user: UserEntity): Promise<void>;
}

/** `ok`: usable. `reauth`: gone for good, the user must sign in again. `unavailable`: couldn't tell (provider or network trouble). */
export type IVcsSessionCheck = 'ok' | 'reauth' | 'unavailable';

export class VcsService {
    constructor(
        private logger: ScopedLogger,
        private appConfig: AppConfig
    ) {}

    /**
     * Validates a CI token against the app's VCS provider and enforces that the CI job
     * belongs to the project the app is bound to.
     */
    async validateCiToken(app: AppEntity, ciToken: string, hints?: ICiCommitHints): Promise<ICiJobData> {
        const integration = await VcsIntegrationEntity.query().filterField('id', app.vcsId).findOneOrUndefined();
        if (!integration || (integration.platform !== 'gitlab' && integration.platform !== 'github')) {
            this.logger.warn(`CI token validation failed: VCS integration not found or unsupported (vcsId=${app.vcsId})`);
            throw new HttpUnauthorizedError();
        }

        // An unbound app would accept any job token from the instance; refuse before the token reaches the provider.
        const expectedProjectId = app.vcsProjectId;
        if (expectedProjectId == null || !Number.isSafeInteger(expectedProjectId) || expectedProjectId <= 0) {
            this.logger.warn(`CI token validation failed: app is not bound to a VCS project (appId=${app.id})`);
            throw new HttpUnauthorizedError('App is not bound to a VCS project');
        }

        const provider = this.createProvider(integration);
        const ciJobData = await provider.validateCiToken(ciToken, expectedProjectId, hints);

        if (ciJobData.vcsProjectId !== app.vcsProjectId) {
            this.logger.warn(`Build creation failed: vcsProjectId mismatch (expected=${app.vcsProjectId}, got=${ciJobData.vcsProjectId})`);
            throw new HttpUnauthorizedError();
        }

        return ciJobData;
    }

    async getProviderLoginUrl(providerId: string, redirectUri: string, state?: string): Promise<string> {
        return this.runWithProvider(providerId, provider => provider.getProviderLoginUrl(redirectUri, state));
    }

    async exchangeProviderCode(providerId: string, redirectUri: string, code: string): Promise<IVcsLoginSessionResponse> {
        return this.runWithProvider(providerId, provider => provider.exchangeProviderCode(redirectUri, code));
    }

    /**
     * Re-runs the CI job behind a build on behalf of the user. Never throws: failures come back as `{ok:false}`.
     * Persists a provider-reported project move even when the re-run itself fails.
     */
    async rerunCiJob(user: UserEntity, app: AppEntity, ciJobId: string, options?: IVcsRerunOptions): Promise<IVcsRerunResult> {
        if (user.vcsId !== app.vcsId) {
            return { ok: false, error: 'Your VCS account belongs to a different provider than this app' };
        }

        let result: IVcsRerunResult;
        try {
            result = await this.runWithProvider(app.vcsId, provider => provider.rerunCiJob(user, app, ciJobId, options));
        } catch (err) {
            this.logger.error('Failed to rerun CI job', err);
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }

        if (result.movedProjectPath && result.movedProjectPath !== app.projectPath) {
            this.logger.info(`Project moved: "${app.projectPath}" → "${result.movedProjectPath}"`);
            app.projectPath = result.movedProjectPath;
            await app.save();
        }
        return result;
    }

    /** Distinct CI re-run targets for a sharded build's job ids (see IVcsServiceImpl.rerunTargets). */
    async getRerunTargets(app: Pick<AppEntity, 'vcsId'>, ciJobIds: string[]): Promise<string[]> {
        const provider = await this.getProvider(app.vcsId);
        return provider.rerunTargets(ciJobIds);
    }

    async resolveProjectUrl(user: UserEntity, vcsId: string, url: string): Promise<IVcsProject> {
        this.assertSameProvider(user, vcsId);
        const provider = await this.getProvider(vcsId);

        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new HttpBadRequestError('Invalid URL');
        }
        const projectPath = provider.parseProjectUrl(parsed);
        if (!projectPath) {
            throw new HttpBadRequestError('Could not extract project path from URL');
        }
        return provider.getProjectByPath(user, projectPath);
    }

    getCommitUrlBase(integration: VcsIntegrationEntity, projectPath: string): string | null {
        try {
            return this.createProvider(integration).getCommitUrlBase(projectPath);
        } catch {
            return null;
        }
    }

    async getTokenUser(integration: VcsIntegrationEntity, token: string): Promise<IVcsTokenUser | null> {
        return this.createProvider(integration).getTokenUser(token);
    }

    async searchProjects(user: UserEntity, vcsId: string, search: string): Promise<IVcsProject[]> {
        this.assertSameProvider(user, vcsId);
        return this.runWithProvider(vcsId, provider => provider.searchProjects(user, search));
    }

    async getProjectByPath(user: UserEntity, vcsId: string, projectPath: string): Promise<IVcsProject> {
        this.assertSameProvider(user, vcsId);
        return this.runWithProvider(vcsId, provider => provider.getProjectByPath(user, projectPath));
    }

    async userCanAccessProject(user: UserEntity, vcsId: string, projectIdentifier: string): Promise<boolean> {
        if (user.vcsId !== vcsId) return false;
        return this.runWithProvider(vcsId, provider => provider.userCanAccessProject(user, projectIdentifier));
    }

    async getUserProjectRole(user: UserEntity, vcsId: string, projectIdentifier: string): Promise<IVcsProjectRole> {
        if (user.vcsId !== vcsId) return 'none';
        return this.runWithProvider(vcsId, provider => provider.getUserProjectRole(user, projectIdentifier));
    }

    /**
     * Whether the user's stored VCS session is still usable, refreshing it when needed. Never clears the stored session on failure:
     * a replica's concurrent refresh may have succeeded, and its result must not be overwritten.
     */
    async checkUserSession(user: UserEntity): Promise<IVcsSessionCheck> {
        if (isVcsSessionFresh(user.vcsSession)) return 'ok';
        try {
            await this.runWithProvider(user.vcsId, provider => provider.ensureUserSession(user));
            return 'ok';
        } catch (err) {
            if (err instanceof VcsSessionExpiredError) return 'reauth';
            this.logger.warn('VCS session check was inconclusive', { userId: user.id, error: err instanceof Error ? err.message : String(err) });
            return 'unavailable';
        }
    }

    async tokenCanAccessProject(token: string, vcsId: string, projectIdentifier: string): Promise<boolean> {
        return this.runWithProvider(vcsId, provider => provider.tokenCanAccessProject(token, projectIdentifier));
    }

    /** A user's stored token only ever goes to the provider they logged in with. */
    private assertSameProvider(user: UserEntity, vcsId: string): void {
        if (user.vcsId !== vcsId) {
            throw new HttpBadRequestError('Your VCS account belongs to a different provider than the one requested');
        }
    }

    // eslint-disable-next-line no-explicit-any
    private async runWithProvider(id: string, action: (provider: IVcsServiceImpl) => Promise<any>): Promise<any> {
        const provider = await this.getProvider(id);
        return action(provider);
    }

    private async getProvider(id: string): Promise<IVcsServiceImpl> {
        const provider = await VcsIntegrationEntity.query().filterField('id', id).findOneOrUndefined();
        if (!provider) {
            throw new Error(`VCS provider with ID ${id} not found`);
        }

        return this.createProvider(provider);
    }

    private createProvider(provider: VcsIntegrationEntity): IVcsServiceImpl {
        const unreadable: string[] = [];
        const config = openIntegrationConfig(provider, unreadable);
        if (unreadable.length) {
            const fields = unreadable.join(' and ');
            this.logger.error(`VCS integration ${provider.id}: ${fields} cannot be decrypted with the configured CRYPTO_SECRET`);
            throw new SecretUnreadableError(`VCS integration ${provider.id}: ${fields} cannot be decrypted`);
        }
        if (provider.platform === 'gitlab') {
            return new VcsGitLabService(config as IGitLabConfig, this.logger, {
                jobTokenAuthEnabled: this.appConfig.GITLAB_JOB_TOKEN_AUTH_ENABLED,
                idTokenAudiences: gitlabIdTokenAudiences(this.appConfig)
            });
        }
        if (provider.platform === 'github') {
            return new VcsGitHubService(config as IGitHubConfig, this.logger);
        }

        throw new Error(`VCS provider with ID ${provider.id} is not supported`);
    }
}
