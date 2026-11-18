import { assert } from '@zyno-io/ts-reflection';
import { createHttpError, HttpBadRequestError, HttpUnauthorizedError } from '@zyno-io/ts-server-foundation';

// GitLab unreachable, slow or failing: retryable by the CLI, unlike a 401 (which means the token is bad)
const HttpServiceUnavailableError = createHttpError(503, 'GitLab is unavailable; try again');
import { Logger, ScopedLogger } from '@zyno-io/ts-server-foundation';
import { JWT, r } from '@zyno-io/ts-server-foundation';
import axios from 'axios';

import type {
    ICiCommitHints,
    ICiJobData,
    IVcsLoginSessionResponse,
    IVcsProject,
    IVcsProjectRole,
    IVcsRerunResult,
    IVcsServiceImpl,
    IVcsTokenUser
} from './Vcs.service';

import { AppEntity } from '../entities/App.entity';
import { UserEntity } from '../entities/User.entity';
import { IGitLabConfig } from '../entities/VcsIntegration.entity';
import { extractCommitSubject, isOidcTokenRejection, verifyOidcJwt } from './oidc/RemoteJwks';
import { vcsAccessToken } from './secrets/VcsSecrets';
import { ensureFreshVcsSession } from './VcsSessionRefresh';

/** GitLab access levels (https://docs.gitlab.com/api/members/#roles). */
const GITLAB_DEVELOPER = 30;
const GITLAB_MAINTAINER = 40;

/** Reads `access_level` from a GitLab member-like object; anything malformed counts as no access. */
function accessLevelOf(value: unknown): number {
    const level = (value as { access_level?: unknown } | null | undefined)?.access_level;
    return typeof level === 'number' && Number.isFinite(level) ? level : 0;
}

/**
 * `membership_state` is the membership's own state ('awaiting' while pending a seat or approval); `state` is the user
 * account's. Either must be active (or absent, on older GitLab), and the membership must not have expired.
 */
function isActiveMembership(data: unknown): boolean {
    const m = (data ?? {}) as { membership_state?: unknown; state?: unknown; expires_at?: unknown };
    if (m.membership_state !== undefined && m.membership_state !== 'active') return false;
    if (m.state !== undefined && m.state !== 'active') return false;
    const expiresAt = typeof m.expires_at === 'string' ? Date.parse(m.expires_at) : NaN;
    return !(expiresAt < Date.now());
}

/** Maps a GitLab access level to a role. The caller has already seen the project, so the floor is 'read'. */
export function gitlabRoleFromAccessLevel(level: number): IVcsProjectRole {
    if (level >= GITLAB_MAINTAINER) return 'maintain';
    if (level >= GITLAB_DEVELOPER) return 'write';
    return 'read';
}

const JWT_SHAPED_RE = /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/;

export interface IGitLabCiAuthOptions {
    /** Accept CI_JOB_TOKEN (validated by calling GitLab). When false, only ID tokens are accepted. */
    jobTokenAuthEnabled: boolean;
    /** Accepted `aud` values for ID tokens. Empty fails closed. */
    idTokenAudiences: string[];
}

/**
 * Accepted `aud` values for GitLab ID tokens: the PUBLIC_URL origin plus GITLAB_ID_TOKEN_AUDIENCES (comma-separated),
 * each with and without a trailing slash. An unusable PUBLIC_URL contributes nothing.
 */
export function gitlabIdTokenAudiences(config: { PUBLIC_URL?: string; GITLAB_ID_TOKEN_AUDIENCES?: string }): string[] {
    const bases: string[] = [];
    if (config.PUBLIC_URL?.trim()) {
        try {
            const url = new URL(config.PUBLIC_URL.trim());
            if (url.protocol === 'https:' || url.protocol === 'http:') bases.push(url.origin);
        } catch {
            // not a URL: no audience from it
        }
    }
    for (const extra of (config.GITLAB_ID_TOKEN_AUDIENCES ?? '').split(',')) {
        const value = extra.trim().replace(/\/+$/, '');
        if (value) bases.push(value);
    }
    return [...new Set(bases.flatMap(b => [b, `${b}/`]))];
}

const DIGITS_RE = /^\d+$/;
const HEX_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Maps the claims of a verified GitLab ID token (plus the CLI's display hints) to job data. */
export function mapGitLabIdTokenClaims(
    claims: Record<string, unknown>,
    hints?: ICiCommitHints
): { ok: true; data: ICiJobData } | { ok: false; reason: string; badRequest?: string } {
    const str = (v: unknown) => (typeof v === 'string' ? v : '');

    const projectId = str(claims.project_id);
    const vcsProjectId = DIGITS_RE.test(projectId) ? Number(projectId) : NaN;
    if (!Number.isSafeInteger(vcsProjectId) || vcsProjectId <= 0) return { ok: false, reason: 'missing or invalid project_id' };

    const jobId = str(claims.job_id);
    if (!DIGITS_RE.test(jobId)) return { ok: false, reason: 'missing or invalid job_id' };

    let branch = str(claims.ref);
    if (!branch) return { ok: false, reason: 'missing ref' };

    // GitLab records merge request pipelines on a pseudo-ref (the job token path reads it from /api/v4/job), while the
    // ID token's `ref` is the MR source branch. Use the same pseudo-ref so both tokens land on the same branch.
    if (claims.pipeline_source === 'merge_request_event') {
        const iid = hints?.mergeRequest?.iid;
        if (typeof iid !== 'string' || !DIGITS_RE.test(iid)) {
            return {
                ok: false,
                reason: 'merge request pipeline without CI_MERGE_REQUEST_IID',
                badRequest: 'merge request pipelines need CI_MERGE_REQUEST_IID'
            };
        }
        const eventType = hints?.mergeRequest?.eventType;
        const suffix = eventType === 'merged_result' ? 'merge' : eventType === 'merge_train' ? 'train' : 'head';
        branch = `refs/merge-requests/${iid}/${suffix}`;
    }

    const sha = str(claims.sha);
    if (!HEX_SHA_RE.test(sha)) return { ok: false, reason: 'missing or invalid sha' };

    const author = typeof hints?.author === 'string' ? hints.author.trim().slice(0, 255) : '';
    return {
        ok: true,
        data: {
            jobId,
            branch,
            commitHash: sha,
            commitSubject: extractCommitSubject(hints?.subject),
            commitAuthor: author || str(claims.user_login).slice(0, 255),
            vcsProjectId
        }
    };
}

export class VcsGitLabService implements IVcsServiceImpl {
    private logger: ScopedLogger;

    constructor(
        private config: IGitLabConfig,
        logger?: ScopedLogger,
        private ciAuth: IGitLabCiAuthOptions = { jobTokenAuthEnabled: true, idTokenAudiences: [] }
    ) {
        this.logger = logger ?? r<ScopedLogger>(Logger);
    }

    async validateCiToken(ciToken: string, expectedProjectId?: number, hints?: ICiCommitHints): Promise<ICiJobData> {
        // A JWT is never replayed to GitLab and never falls back to the job-token path
        if (JWT_SHAPED_RE.test(ciToken)) return this.validateIdToken(ciToken, expectedProjectId, hints);
        if (!this.ciAuth.jobTokenAuthEnabled) {
            this.logger.warn('CI token validation failed: job-token auth is disabled and the token is not an ID token');
            throw new HttpUnauthorizedError('CI job tokens are disabled on this server; use a GitLab ID token (id_tokens: PIXELCI_ID_TOKEN)');
        }
        return this.validateJobToken(ciToken);
    }

    private async validateIdToken(ciToken: string, expectedProjectId: number | undefined, hints?: ICiCommitHints): Promise<ICiJobData> {
        const audience = this.ciAuth.idTokenAudiences;
        if (!audience.length) {
            this.logger.warn('CI token validation failed: no accepted GitLab ID token audiences (set PUBLIC_URL or GITLAB_ID_TOKEN_AUDIENCES)');
            throw new HttpUnauthorizedError();
        }

        const base = this.config.url.replace(/\/+$/, '');
        let claims: Record<string, unknown>;
        try {
            claims = await verifyOidcJwt(ciToken, {
                issuer: [base, `${base}/`],
                jwksUrl: `${base}/oauth/discovery/keys`,
                audience,
                algorithms: ['RS256'],
                clockTolerance: 60
            });
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            if (isOidcTokenRejection(err)) {
                this.logger.warn(`CI token validation failed: GitLab ID token verification failed (${detail})`);
                throw new HttpUnauthorizedError();
            }
            this.logger.warn(`CI token validation failed: GitLab JWKS fetch failed (${detail})`);
            throw new HttpServiceUnavailableError();
        }

        // Bind to the app's project before trusting any other claim
        const claimedProjectId = typeof claims.project_id === 'string' ? claims.project_id : '';
        if (expectedProjectId == null || claimedProjectId !== String(expectedProjectId)) {
            this.logger.warn(
                `CI token validation failed: GitLab ID token project_id mismatch (expected=${expectedProjectId}, got=${String(claims.project_id)})`
            );
            throw new HttpUnauthorizedError();
        }

        const mapped = mapGitLabIdTokenClaims(claims, hints);
        if (!mapped.ok) {
            if (mapped.badRequest) throw new HttpBadRequestError(mapped.badRequest);
            this.logger.warn(`CI token validation failed: GitLab ID token has ${mapped.reason}`);
            throw new HttpUnauthorizedError();
        }
        return mapped.data;
    }

    private async validateJobToken(ciToken: string): Promise<ICiJobData> {
        let jobResponse: Response;
        try {
            jobResponse = await fetch(`${this.config.url}/api/v4/job`, {
                headers: { 'JOB-TOKEN': ciToken },
                // Bounded so a hung GitLab can't leave a create stuck long enough to run late, after the CLI has retried
                signal: AbortSignal.timeout(10_000)
            });
        } catch (err) {
            this.logger.warn(`CI token validation failed: GitLab /api/v4/job request failed (${err})`);
            throw new HttpServiceUnavailableError();
        }

        if (!jobResponse.ok) {
            this.logger.warn(`CI token validation failed: GitLab /api/v4/job returned ${jobResponse.status} ${jobResponse.statusText}`);
            if (jobResponse.status >= 500 || jobResponse.status === 429) throw new HttpServiceUnavailableError();
            throw new HttpUnauthorizedError();
        }

        const jobData = (await jobResponse.json()) as {
            id?: number;
            ref?: string;
            pipeline?: { project_id?: number; sha?: string };
            commit?: { title?: string; author_name?: string };
        };

        const vcsProjectId = jobData.pipeline?.project_id;
        if (!vcsProjectId) {
            this.logger.warn('CI token validation failed: GitLab job response missing pipeline.project_id');
            throw new HttpUnauthorizedError();
        }

        return {
            jobId: String(jobData.id ?? ''),
            branch: jobData.ref ?? '',
            commitHash: jobData.pipeline?.sha ?? '',
            commitSubject: jobData.commit?.title ?? '',
            commitAuthor: jobData.commit?.author_name ?? '',
            vcsProjectId
        };
    }

    async getProviderLoginUrl(redirectUri: string, state?: string): Promise<string> {
        const params = new URLSearchParams({
            client_id: this.config.clientId,
            redirect_uri: redirectUri,
            state: state ?? '',
            response_type: 'code',
            scope: 'openid api'
        });
        return `${this.config.url}/oauth/authorize?${params.toString()}`;
    }

    async exchangeProviderCode(redirectUri: string, code: string): Promise<IVcsLoginSessionResponse> {
        try {
            const response = await axios.post(
                `${this.config.url}/oauth/token`,
                {
                    client_id: this.config.clientId,
                    client_secret: this.config.clientSecret,
                    redirect_uri: redirectUri,
                    code,
                    grant_type: 'authorization_code'
                },
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            assert<{
                access_token: string;
                expires_in: number;
                refresh_token: string;
                id_token: string;
            }>(response.data);

            const idToken = await JWT.decode(response.data.id_token);
            assert<true>(idToken.isValid);
            assert<{ name: string }>(idToken.payload);

            return {
                id: idToken.subject,
                name: idToken.payload.name,
                accessToken: response.data.access_token,
                expiresAt: Date.now() + response.data.expires_in * 1000,
                refreshToken: response.data.refresh_token,
                redirectUri
            };
        } catch (err) {
            if (axios.isAxiosError(err)) {
                const data = err.response?.data as { error?: string; error_description?: string } | undefined;
                throw new HttpBadRequestError(data?.error_description ?? data?.error ?? 'GitLab session expired; please sign in again');
            }
            throw err;
        }
    }

    async rerunCiJob(user: UserEntity, app: Pick<AppEntity, 'projectPath' | 'vcsProjectId'>, ciJobId: string): Promise<IVcsRerunResult> {
        try {
            return { ok: true, url: await this.retryJob(user, app.projectPath, ciJobId) };
        } catch (err) {
            if (!axios.isAxiosError(err) || err.response?.status !== 405) return this.rerunFailure(err);

            // Project may have moved: securely look up the current path via the GitLab API
            let currentPath: string;
            try {
                currentPath = await this.getProjectPath(user, app.projectPath);
            } catch (lookupErr) {
                return this.rerunFailure(lookupErr);
            }
            if (currentPath === app.projectPath) return this.rerunFailure(err); // not a move

            try {
                return { ok: true, url: await this.retryJob(user, currentPath, ciJobId), movedProjectPath: currentPath };
            } catch (retryErr) {
                return { ...this.rerunFailure(retryErr), movedProjectPath: currentPath };
            }
        }
    }

    rerunTargets(ciJobIds: string[]): string[] {
        return [...new Set(ciJobIds)];
    }

    private rerunFailure(err: unknown): { ok: false; error: string } {
        this.logger.error('Failed to rerun CI job', err);
        if (axios.isAxiosError(err)) {
            const data = err.response?.data;
            const message = typeof data?.message === 'string' ? data.message : err.message;
            return { ok: false, error: `GitLab refused to re-run the job${err.response ? ` (HTTP ${err.response.status})` : ''}: ${message}` };
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    private async retryJob(user: UserEntity, projectPath: string, jobId: string): Promise<string> {
        await this.renewToken(user);

        const response = await axios.post(
            `${this.config.url}/api/v4/projects/${encodeURIComponent(projectPath)}/jobs/${jobId}/retry`,
            {},
            {
                headers: {
                    Authorization: `Bearer ${vcsAccessToken(user)}`
                }
            }
        );

        assert<{
            id: number;
            pipeline: {
                id: number;
            };
        }>(response.data);

        return `${this.config.url}/${projectPath}/-/pipelines/${response.data.pipeline.id}`;
    }

    private async getProjectPath(user: UserEntity, projectPath: string): Promise<string> {
        await this.renewToken(user);

        const response = await axios.get(`${this.config.url}/api/v4/projects/${encodeURIComponent(projectPath)}`, {
            headers: {
                Authorization: `Bearer ${vcsAccessToken(user)}`
            }
        });

        return response.data.path_with_namespace;
    }

    parseProjectUrl(url: URL): string | null {
        const projectPath = url.pathname
            .replace(/^\//, '')
            .replace(/\/-\/.*$/, '')
            .replace(/\.git$/, '');
        return projectPath || null;
    }

    getCommitUrlBase(projectPath: string): string {
        return `${this.config.url}/${projectPath}/-/commit`;
    }

    async getTokenUser(token: string): Promise<IVcsTokenUser | null> {
        let response: Response;
        try {
            response = await fetch(`${this.config.url}/api/v4/user`, {
                headers: { 'PRIVATE-TOKEN': token }
            });
        } catch (err) {
            this.logger.warn(`VCS token validation: request to ${this.config.url}/api/v4/user failed (${err})`);
            return null;
        }
        if (!response.ok) return null;

        const body = (await response.json()) as { id?: number };
        return body.id ? { id: String(body.id) } : null;
    }

    async searchProjects(user: UserEntity, search: string): Promise<IVcsProject[]> {
        await this.renewToken(user);

        const response = await axios.get(`${this.config.url}/api/v4/projects`, {
            params: {
                search,
                membership: true,
                order_by: 'last_activity_at',
                per_page: 20
            },
            headers: {
                Authorization: `Bearer ${vcsAccessToken(user)}`
            }
        });

        return response.data.map(
            (p: {
                id: number;
                name: string;
                path_with_namespace: string;
                web_url: string;
                description: string | null;
                default_branch: string | null;
            }) => ({
                id: String(p.id),
                name: p.name,
                projectPath: p.path_with_namespace,
                webUrl: p.web_url,
                description: p.description ?? '',
                defaultBranch: p.default_branch ?? undefined
            })
        );
    }

    async getProjectByPath(user: UserEntity, projectPath: string): Promise<IVcsProject> {
        await this.renewToken(user);

        const response = await axios.get(`${this.config.url}/api/v4/projects/${encodeURIComponent(projectPath)}`, {
            headers: {
                Authorization: `Bearer ${vcsAccessToken(user)}`
            }
        });

        const p = response.data;
        return {
            id: String(p.id),
            name: p.name,
            projectPath: p.path_with_namespace,
            webUrl: p.web_url,
            description: p.description ?? '',
            defaultBranch: p.default_branch ?? undefined
        };
    }

    async userCanAccessProject(user: UserEntity, projectIdentifier: string): Promise<boolean> {
        if (!user.vcsSession) return false;

        try {
            await this.renewToken(user);
        } catch (err) {
            this.logger.warn('Token renewal failed during project access check', { userId: user.id, error: String(err) });
            return false;
        }

        return this.checkProjectAccess(vcsAccessToken(user), projectIdentifier);
    }

    async tokenCanAccessProject(token: string, projectIdentifier: string): Promise<boolean> {
        return this.checkProjectAccess(token, projectIdentifier);
    }

    /**
     * `GET /projects/:id` reports direct project membership (`project_access`) and the highest membership in the project's
     * group or its ancestors (`group_access`). Neither covers access through a group the project (or an ancestor) is shared
     * with, so below Maintainer we ask `members/all/:user_id`, whose access_level is the user's effective level.
     */
    async getUserProjectRole(user: UserEntity, projectIdentifier: string): Promise<IVcsProjectRole> {
        if (!user.vcsSession) return 'none';
        // Token renewal and transport/5xx failures propagate: the caller denies without caching a transient error.
        await this.renewToken(user);

        const projectUrl = `${this.config.url}/api/v4/projects/${encodeURIComponent(projectIdentifier)}`;
        const headers = { Authorization: `Bearer ${vcsAccessToken(user)}` };
        const definitive = (status: number) => status === 200 || status === 401 || status === 403 || status === 404;

        const project = await axios.get(projectUrl, { headers, validateStatus: definitive });
        if (project.status !== 200) return 'none';

        const permissions = project.data?.permissions;
        let level = Math.max(accessLevelOf(permissions?.project_access), accessLevelOf(permissions?.group_access));

        // vcsUserId is the OIDC `sub`, which GitLab sets to the numeric user id. Below Maintainer, a shared group may grant more.
        if (level < GITLAB_MAINTAINER && /^\d+$/.test(user.vcsUserId)) {
            // A 5xx or transport failure throws (deny, uncached); a definitive 401/403/404 keeps the first result.
            const member = await axios.get(`${projectUrl}/members/all/${user.vcsUserId}`, { headers, validateStatus: definitive });
            if (member.status === 200 && isActiveMembership(member.data)) level = Math.max(level, accessLevelOf(member.data));
        }

        return gitlabRoleFromAccessLevel(level);
    }

    private async checkProjectAccess(token: string, projectIdentifier: string): Promise<boolean> {
        try {
            const response = await axios.get(`${this.config.url}/api/v4/projects/${encodeURIComponent(projectIdentifier)}`, {
                headers: { Authorization: `Bearer ${token}` },
                validateStatus: status => status === 200 || status === 401 || status === 403 || status === 404
            });
            return response.status === 200;
        } catch (err) {
            this.logger.warn('Project access check request failed', { projectIdentifier, error: String(err) });
            return false;
        }
    }

    async ensureUserSession(user: UserEntity): Promise<void> {
        await this.renewToken(user);
    }

    private async renewToken(user: UserEntity): Promise<void> {
        try {
            await ensureFreshVcsSession(
                user,
                async session => {
                    this.logger.info('Refreshing GitLab token', { userId: user.id });
                    const response = await axios.post(
                        `${this.config.url}/oauth/token`,
                        {
                            client_id: this.config.clientId,
                            client_secret: this.config.clientSecret,
                            grant_type: 'refresh_token',
                            refresh_token: session.refreshToken,
                            redirect_uri: session.redirectUri
                        },
                        {
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded'
                            }
                        }
                    );

                    assert<{
                        access_token: string;
                        expires_in: number;
                        refresh_token: string;
                    }>(response.data);

                    return {
                        ...session,
                        accessToken: response.data.access_token,
                        expiresAt: Date.now() + response.data.expires_in * 1000,
                        refreshToken: response.data.refresh_token
                    };
                },
                err => axios.isAxiosError(err) && err.response?.data?.error === 'invalid_grant'
            );
        } catch (err) {
            if (axios.isAxiosError(err)) {
                throw new HttpBadRequestError(err.response?.data);
            }
            throw err;
        }
    }
}
