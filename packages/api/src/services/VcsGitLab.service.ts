import { assert } from '@zyno-io/ts-reflection';
import { HttpBadRequestError, HttpUnauthorizedError } from '@zyno-io/ts-server-foundation';
import { Logger, ScopedLogger } from '@zyno-io/ts-server-foundation';
import { JWT, r } from '@zyno-io/ts-server-foundation';
import axios from 'axios';

import type {
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

export class VcsGitLabService implements IVcsServiceImpl {
    private logger: ScopedLogger;

    constructor(
        private config: IGitLabConfig,
        logger?: ScopedLogger
    ) {
        this.logger = logger ?? r<ScopedLogger>(Logger);
    }

    async validateCiToken(ciToken: string): Promise<ICiJobData> {
        let jobResponse: Response;
        try {
            jobResponse = await fetch(`${this.config.url}/api/v4/job`, {
                headers: { 'JOB-TOKEN': ciToken }
            });
        } catch (err) {
            this.logger.warn(`CI token validation failed: GitLab /api/v4/job request failed (${err})`);
            throw new HttpUnauthorizedError();
        }

        if (!jobResponse.ok) {
            this.logger.warn(`CI token validation failed: GitLab /api/v4/job returned ${jobResponse.status} ${jobResponse.statusText}`);
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
        return `${this.config.url}/oauth/authorize?client_id=${this.config.clientId}&redirect_uri=${redirectUri}&state=${state ?? ''}&response_type=code&scope=openid+api`;
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
                    Authorization: `Bearer ${user.vcsSession!.accessToken}`
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
                Authorization: `Bearer ${user.vcsSession!.accessToken}`
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
                Authorization: `Bearer ${user.vcsSession!.accessToken}`
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
                Authorization: `Bearer ${user.vcsSession!.accessToken}`
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

        return this.checkProjectAccess(user.vcsSession.accessToken, projectIdentifier);
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
        const headers = { Authorization: `Bearer ${user.vcsSession.accessToken}` };
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
