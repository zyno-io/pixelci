import { HttpBadRequestError, HttpUnauthorizedError, Logger, r, ScopedLogger } from '@zyno-io/ts-server-foundation';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import type { ICiJobData, IVcsLoginSessionResponse, IVcsProject, IVcsRerunResult, IVcsServiceImpl, IVcsTokenUser } from './Vcs.service';

import { AppEntity } from '../entities/App.entity';
import { UserEntity } from '../entities/User.entity';
import { IGitHubConfig } from '../entities/VcsIntegration.entity';

const DEFAULT_WEB_URL = 'https://github.com';
const DEFAULT_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

/**
 * Events whose OIDC `ref`/`sha` (and `head_ref` for pull_request) describe the code under test.
 * Others are rejected: e.g. pull_request_target, workflow_run and issue_comment carry the base/default
 * branch ref and sha, which would record builds against the wrong branch/commit and break dedupe.
 */
const ALLOWED_EVENTS = new Set(['push', 'pull_request', 'workflow_dispatch', 'schedule']);

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(jwksUrl: string) {
    let jwks = jwksCache.get(jwksUrl);
    if (!jwks) {
        jwks = createRemoteJWKSet(new URL(jwksUrl));
        jwksCache.set(jwksUrl, jwks);
    }
    return jwks;
}

/**
 * GitHub provider. Slice 1 supports CI authentication via GitHub Actions OIDC tokens only;
 * user login, project search/lookup and CI rerun land in slice 2.
 */
export class VcsGitHubService implements IVcsServiceImpl {
    private logger: ScopedLogger;

    constructor(
        private config: IGitHubConfig,
        logger?: ScopedLogger
    ) {
        this.logger = logger ?? r<ScopedLogger>(Logger);
    }

    private getIssuer(): string {
        if (this.config.oidcIssuer) return this.config.oidcIssuer;
        const url = this.config.url?.replace(/\/+$/, '');
        if (url && url !== DEFAULT_WEB_URL) return `${url}/_services/token`;
        return DEFAULT_OIDC_ISSUER;
    }

    private fail(reason: string): never {
        this.logger.warn(`CI token validation failed: ${reason}`);
        throw new HttpUnauthorizedError();
    }

    async validateCiToken(ciToken: string): Promise<ICiJobData> {
        // jose skips the aud check entirely when `audience` is undefined — never let that happen.
        const audience = this.config.oidcAudience;
        if (typeof audience !== 'string' || !audience.trim()) {
            return this.fail('GitHub integration has no oidcAudience configured');
        }

        let claims: Record<string, unknown>;
        try {
            const issuer = this.getIssuer();
            const jwks = getJwks(`${issuer.replace(/\/+$/, '')}/.well-known/jwks`);
            const result = await jwtVerify(ciToken, jwks, {
                issuer,
                audience,
                algorithms: ['RS256'],
                requiredClaims: ['exp']
            });
            claims = result.payload;
        } catch (err) {
            return this.fail(`GitHub OIDC token verification failed (${err instanceof Error ? err.message : String(err)})`);
        }

        const str = (v: unknown) => (typeof v === 'string' ? v : '');

        const repositoryId = str(claims.repository_id);
        const vcsProjectId = /^\d+$/.test(repositoryId) ? Number(repositoryId) : NaN;
        if (!Number.isSafeInteger(vcsProjectId) || vcsProjectId <= 0) {
            return this.fail('GitHub OIDC token has missing or invalid repository_id');
        }

        const sha = str(claims.sha);
        const ref = str(claims.ref);
        const runId = str(claims.run_id);
        if (!sha || !ref || !runId) {
            return this.fail('GitHub OIDC token missing required claim (sha, ref, or run_id)');
        }

        const eventName = str(claims.event_name);
        if (!ALLOWED_EVENTS.has(eventName)) {
            return this.fail(`GitHub OIDC token from unsupported event "${eventName}"`);
        }

        const headRef = eventName === 'pull_request' ? str(claims.head_ref) : '';
        let branch: string;
        if (headRef) branch = headRef;
        else if (ref.startsWith('refs/heads/') && ref.length > 'refs/heads/'.length) branch = ref.slice('refs/heads/'.length);
        else if (ref.startsWith('refs/tags/') && ref.length > 'refs/tags/'.length) branch = ref.slice('refs/tags/'.length);
        else return this.fail(`GitHub OIDC token has unsupported ref "${ref}"`);

        return {
            jobId: runId,
            branch,
            commitHash: sha,
            commitSubject: '',
            commitAuthor: str(claims.actor),
            vcsProjectId
        };
    }

    private unsupported(what: string): never {
        throw new HttpBadRequestError(`GitHub integration does not support ${what} yet`);
    }

    async getProviderLoginUrl(_redirectUri: string, _state?: string): Promise<string> {
        return this.unsupported('login');
    }

    async exchangeProviderCode(_redirectUri: string, _code: string): Promise<IVcsLoginSessionResponse> {
        return this.unsupported('login');
    }

    async rerunCiJob(_user: UserEntity, _app: Pick<AppEntity, 'projectPath' | 'vcsProjectId'>, _ciJobId: string): Promise<IVcsRerunResult> {
        return { ok: false, error: 'GitHub integration does not support rerunning CI jobs yet' };
    }

    parseProjectUrl(_url: URL): string | null {
        return null;
    }

    getCommitUrlBase(projectPath: string): string {
        const web = (this.config.url ?? DEFAULT_WEB_URL).replace(/\/+$/, '');
        return `${web}/${projectPath}/commit`;
    }

    async getTokenUser(_token: string): Promise<IVcsTokenUser | null> {
        return null;
    }

    async searchProjects(_user: UserEntity, _search: string): Promise<IVcsProject[]> {
        return this.unsupported('project search');
    }

    async getProjectByPath(_user: UserEntity, _projectPath: string): Promise<IVcsProject> {
        return this.unsupported('project lookup');
    }

    async userCanAccessProject(_user: UserEntity, _projectIdentifier: string): Promise<boolean> {
        return false;
    }

    async tokenCanAccessProject(_token: string, _projectIdentifier: string): Promise<boolean> {
        return false;
    }
}
