import { HttpBadRequestError, HttpUnauthorizedError, ScopedLogger } from '@zyno-io/ts-server-foundation';

import { AppEntity } from '../entities/App.entity';
import { IUserVcsSession, UserEntity } from '../entities/User.entity';
import { IGitHubConfig, IGitLabConfig, VcsIntegrationEntity } from '../entities/VcsIntegration.entity';
import { VcsGitHubService } from './VcsGitHub.service';
import { VcsGitLabService } from './VcsGitLab.service';

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

export type IVcsRerunResult = { ok: true; url: string; movedProjectPath?: string } | { ok: false; error: string; movedProjectPath?: string };

export interface IVcsTokenUser {
    id: string;
}

export interface IVcsServiceImpl {
    /**
     * `expectedProjectId` is the app's bound project; providers that make further outbound calls after verifying
     * the token (e.g. GitHub commit metadata) must reject a mismatch before doing so. VcsService re-checks binding.
     */
    validateCiToken(ciToken: string, expectedProjectId: number | null): Promise<ICiJobData>;
    getProviderLoginUrl(redirectUri: string, state?: string): Promise<string>;
    exchangeProviderCode(redirectUri: string, code: string): Promise<IVcsLoginSessionResponse>;
    rerunCiJob(user: UserEntity, app: Pick<AppEntity, 'projectPath' | 'vcsProjectId'>, ciJobId: string): Promise<IVcsRerunResult>;
    searchProjects(user: UserEntity, search: string): Promise<IVcsProject[]>;
    getProjectByPath(user: UserEntity, projectPath: string): Promise<IVcsProject>;
    /** Extracts the project path from a pasted repository URL; null when the URL doesn't belong to this provider. */
    parseProjectUrl(url: URL): string | null;
    getCommitUrlBase(projectPath: string): string;
    userCanAccessProject(user: UserEntity, projectIdentifier: string): Promise<boolean>;
    tokenCanAccessProject(token: string, projectIdentifier: string): Promise<boolean>;
    /** Resolves the provider user a personal access token belongs to; null if the token is invalid. */
    getTokenUser(token: string): Promise<IVcsTokenUser | null>;
}

export class VcsService {
    constructor(private logger: ScopedLogger) {}

    /**
     * Validates a CI token against the app's VCS provider and enforces that the CI job
     * belongs to the project the app is bound to.
     */
    async validateCiToken(app: AppEntity, ciToken: string): Promise<ICiJobData> {
        const integration = await VcsIntegrationEntity.query().filterField('id', app.vcsId).findOneOrUndefined();
        if (!integration || (integration.platform !== 'gitlab' && integration.platform !== 'github')) {
            this.logger.warn(`CI token validation failed: VCS integration not found or unsupported (vcsId=${app.vcsId})`);
            throw new HttpUnauthorizedError();
        }

        const provider = this.createProvider(integration);
        const ciJobData = await provider.validateCiToken(ciToken, app.vcsProjectId);

        // Legacy GitLab apps without a bound project are allowed; everything else must match.
        const legacyUnbound = !app.vcsProjectId && integration.platform === 'gitlab';
        if (!legacyUnbound && ciJobData.vcsProjectId !== app.vcsProjectId) {
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
    async rerunCiJob(user: UserEntity, app: AppEntity, ciJobId: string): Promise<IVcsRerunResult> {
        if (user.vcsId !== app.vcsId) {
            return { ok: false, error: 'Your VCS account belongs to a different provider than this app' };
        }

        let result: IVcsRerunResult;
        try {
            result = await this.runWithProvider(app.vcsId, provider => provider.rerunCiJob(user, app, ciJobId));
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
        if (provider.platform === 'gitlab') {
            return new VcsGitLabService(provider.config as IGitLabConfig, this.logger);
        }
        if (provider.platform === 'github') {
            return new VcsGitHubService(provider.config as IGitHubConfig, this.logger);
        }

        throw new Error(`VCS provider with ID ${provider.id} is not supported`);
    }
}
