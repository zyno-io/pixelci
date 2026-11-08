import { HttpUnauthorizedError, ScopedLogger } from '@zyno-io/ts-server-foundation';

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

export interface IVcsServiceImpl {
    validateCiToken(ciToken: string): Promise<ICiJobData>;
    getProviderLoginUrl(redirectUri: string, state?: string): Promise<string>;
    exchangeProviderCode(redirectUri: string, code: string): Promise<IVcsLoginSessionResponse>;
    rerunCiJob(user: UserEntity, projectPath: string, jobId: string): Promise<string>;
    getProjectPath(user: UserEntity, projectPath: string): Promise<string>;
    searchProjects(user: UserEntity, search: string): Promise<IVcsProject[]>;
    getProjectByPath(user: UserEntity, projectPath: string): Promise<IVcsProject>;
    userCanAccessProject(user: UserEntity, projectIdentifier: string): Promise<boolean>;
    tokenCanAccessProject(token: string, projectIdentifier: string): Promise<boolean>;
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
        const ciJobData = await provider.validateCiToken(ciToken);

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

    async rerunCiJob(user: UserEntity, vcsId: string, projectPath: string, jobId: string): Promise<string> {
        return this.runWithProvider(vcsId, provider => provider.rerunCiJob(user, projectPath, jobId));
    }

    async getProjectPath(user: UserEntity, vcsId: string, projectPath: string): Promise<string> {
        return this.runWithProvider(vcsId, provider => provider.getProjectPath(user, projectPath));
    }

    async searchProjects(user: UserEntity, vcsId: string, search: string): Promise<IVcsProject[]> {
        return this.runWithProvider(vcsId, provider => provider.searchProjects(user, search));
    }

    async getProjectByPath(user: UserEntity, vcsId: string, projectPath: string): Promise<IVcsProject> {
        return this.runWithProvider(vcsId, provider => provider.getProjectByPath(user, projectPath));
    }

    async userCanAccessProject(user: UserEntity, vcsId: string, projectIdentifier: string): Promise<boolean> {
        return this.runWithProvider(vcsId, provider => provider.userCanAccessProject(user, projectIdentifier));
    }

    async tokenCanAccessProject(token: string, vcsId: string, projectIdentifier: string): Promise<boolean> {
        return this.runWithProvider(vcsId, provider => provider.tokenCanAccessProject(token, projectIdentifier));
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
