import {
    HttpAccessDeniedError,
    HttpBadRequestError,
    HttpNotFoundError,
    HttpUnauthorizedError,
    Logger,
    r,
    ScopedLogger
} from '@zyno-io/ts-server-foundation';
import axios from 'axios';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import type {
    ICiJobData,
    IVcsLoginSessionResponse,
    IVcsProject,
    IVcsRerunOptions,
    IVcsRerunResult,
    IVcsProjectRole,
    IVcsServiceImpl,
    IVcsTokenUser
} from './Vcs.service';

import { AppEntity } from '../entities/App.entity';
import { IUserVcsSession, UserEntity } from '../entities/User.entity';
import { IGitHubConfig } from '../entities/VcsIntegration.entity';
import { withInstallationToken, appJwtGet } from './github/GitHubAppAuth';
import { createGitHubClient, describeGitHubError, encodeRepoPath, githubUrls, GITHUB_REQUEST_TIMEOUT_MS } from './github/GitHubHttp';
import { ensureFreshVcsSession } from './VcsSessionRefresh';

const DEFAULT_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

/**
 * Events whose OIDC `ref`/`sha` (and `head_ref` for pull_request) describe the code under test.
 * Others are rejected: e.g. pull_request_target, workflow_run and issue_comment carry the base/default
 * branch ref and sha, which would record builds against the wrong branch/commit and break dedupe.
 */
const ALLOWED_EVENTS = new Set(['push', 'pull_request', 'workflow_dispatch', 'schedule']);

const METADATA_BUDGET_MS = 5_000;
const SEARCH_CACHE_TTL_MS = 60_000;
const SEARCH_MAX_RESULTS = 20;
const SEARCH_MAX_REPO_PAGES = 10;
const NO_EXPIRY = Number.MAX_SAFE_INTEGER;

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(jwksUrl: string) {
    let jwks = jwksCache.get(jwksUrl);
    if (!jwks) {
        jwks = createRemoteJWKSet(new URL(jwksUrl));
        jwksCache.set(jwksUrl, jwks);
    }
    return jwks;
}

// --- pure helpers (exported for unit tests) ---

/** `run:check_run_id` when the OIDC token carries a numeric check_run_id (the Actions job id), else just the run id. */
export function buildCiJobId(runId: string, checkRunId: unknown): string {
    const id = typeof checkRunId === 'number' && Number.isSafeInteger(checkRunId) ? String(checkRunId) : checkRunId;
    return typeof id === 'string' && /^\d+$/.test(id) ? `${runId}:${id}` : runId;
}

/** Parses a stored ciJobId (`run` or `run:job`). */
export function parseCiJobId(ciJobId: string): { runId: string; jobId?: string } | null {
    const m = /^(\d+)(?::(\d+))?$/.exec(ciJobId ?? '');
    if (!m) return null;
    return m[2] ? { runId: m[1], jobId: m[2] } : { runId: m[1] };
}

/** Branch name for a build; null when the ref is unusable. Tag pushes become a branch named after the tag. */
export function deriveBranch(eventName: string, ref: string, headRef: string): string | null {
    if (eventName === 'pull_request' && headRef) return headRef;
    if (ref.startsWith('refs/heads/') && ref.length > 'refs/heads/'.length) return ref.slice('refs/heads/'.length);
    if (ref.startsWith('refs/tags/') && ref.length > 'refs/tags/'.length) return ref.slice('refs/tags/'.length);
    return null;
}

/**
 * Maps the `permissions` object GitHub returns on a repository (for the authenticated user) to a role.
 * GitHub sends admin/maintain/push/triage/pull; anything missing or malformed fails closed to 'read'.
 */
export function githubRoleFromPermissions(permissions: unknown): IVcsProjectRole {
    if (!permissions || typeof permissions !== 'object') return 'read';
    const p = permissions as { admin?: unknown; maintain?: unknown; push?: unknown };
    if (p.admin === true || p.maintain === true) return 'maintain';
    if (p.push === true) return 'write';
    return 'read';
}

/** First line of a commit message, at most 255 characters (the builds.commitSubject column). */
export function extractCommitSubject(message: unknown): string {
    if (typeof message !== 'string') return '';
    return message.split(/\r?\n/, 1)[0].trim().slice(0, 255);
}

/** N from `refs/pull/N/merge`. */
export function parsePullNumber(ref: string): number | null {
    const m = /^refs\/pull\/(\d+)\/merge$/.exec(ref);
    return m ? Number(m[1]) : null;
}

/** `owner/repo` from a pasted repository URL whose host equals the integration's host; null otherwise. */
export function parseGitHubProjectUrl(web: string, url: URL): string | null {
    let webHost: string;
    try {
        webHost = new URL(web).host.toLowerCase();
    } catch {
        return null;
    }
    if (url.host.toLowerCase() !== webHost) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    const owner = segments[0];
    const repo = segments[1].replace(/\.git$/, '');
    if (!owner || !repo) return null;
    return `${owner}/${repo}`;
}

/** Token refresh failed for a non-auth reason (network/5xx); the user's session itself may be fine. */
class GitHubTransientError extends HttpBadRequestError {}

class GitHubOAuthError extends Error {
    constructor(
        public code: string,
        description?: string
    ) {
        super(description || code);
    }
}

interface IGitHubRepo {
    id: number;
    name: string;
    full_name: string;
    html_url: string;
    description?: string | null;
    default_branch?: string | null;
    pushed_at?: string | null;
}

type ISearchEntry = IVcsProject & { pushedAt: number };
const searchCache = new Map<string, { expiresAt: number; items: ISearchEntry[] }>();
const searchInFlight = new Map<string, Promise<ISearchEntry[]>>();

function toProject(repo: IGitHubRepo): IVcsProject {
    return {
        id: String(repo.id),
        name: repo.name,
        projectPath: repo.full_name,
        webUrl: repo.html_url,
        description: repo.description ?? '',
        defaultBranch: repo.default_branch ?? undefined
    };
}

export class VcsGitHubService implements IVcsServiceImpl {
    private logger: ScopedLogger;
    private urls: ReturnType<typeof githubUrls>;

    constructor(
        private config: IGitHubConfig,
        logger?: ScopedLogger
    ) {
        this.logger = logger ?? r<ScopedLogger>(Logger);
        this.urls = githubUrls(config);
    }

    private getIssuer(): string {
        if (this.config.oidcIssuer) return this.config.oidcIssuer;
        return this.urls.web !== 'https://github.com' ? `${this.urls.web}/_services/token` : DEFAULT_OIDC_ISSUER;
    }

    private fail(reason: string): never {
        this.logger.warn(`CI token validation failed: ${reason}`);
        throw new HttpUnauthorizedError();
    }

    // ---------------------------------------------------------------- CI auth

    async validateCiToken(ciToken: string, expectedProjectId: number | null): Promise<ICiJobData> {
        // jose skips the aud check entirely when `audience` is undefined — never let that happen.
        const rawAudience = this.config.oidcAudience;
        if (typeof rawAudience !== 'string' || !rawAudience.trim()) {
            return this.fail('GitHub integration has no oidcAudience configured');
        }
        // The CLI requests PIXELCI_API_URL with trailing slashes stripped.
        const audience = rawAudience.trim().replace(/\/+$/, '');

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

        const branch = deriveBranch(eventName, ref, str(claims.head_ref));
        if (!branch) return this.fail(`GitHub OIDC token has unsupported ref "${ref}"`);

        // Reject tokens from other repositories before any outbound GitHub call (commit metadata below), so a
        // validly-signed token from an unrelated repo can't make PixelCI spend App credentials or rate budget.
        if (expectedProjectId == null || vcsProjectId !== expectedProjectId) {
            return this.fail(`Build creation failed: vcsProjectId mismatch (expected=${expectedProjectId}, got=${vcsProjectId})`);
        }

        const actor = str(claims.actor);
        let commitSubject = '';
        let commitAuthor = actor.slice(0, 255);

        // Best-effort: a failure here must never fail the build.
        if (this.config.appId && this.config.privateKey) {
            const repository = str(claims.repository);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), METADATA_BUDGET_MS);
            try {
                const meta = await this.fetchCommitMetadata(
                    repository,
                    vcsProjectId,
                    sha,
                    eventName === 'pull_request' ? ref : '',
                    controller.signal
                );
                commitSubject = meta.subject;
                if (meta.author) commitAuthor = meta.author.slice(0, 255);
            } catch (err) {
                this.logger.warn(`GitHub commit metadata lookup failed (build continues without it): ${describeGitHubError(err).message}`);
            } finally {
                clearTimeout(timer);
            }
        }

        return {
            jobId: buildCiJobId(runId, claims.check_run_id),
            branch,
            commitHash: sha,
            commitSubject,
            commitAuthor,
            vcsProjectId
        };
    }

    private async fetchCommitMetadata(
        repository: string,
        repoId: number,
        sha: string,
        prRef: string,
        signal: AbortSignal
    ): Promise<{ subject: string; author: string }> {
        if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error(`invalid repository claim "${repository}"`);
        const repoPath = encodeRepoPath(repository);

        const getCommit = (commitSha: string) =>
            withInstallationToken(
                this.config,
                repository,
                repoId,
                async token => {
                    const res = await createGitHubClient(this.urls, token).get<IGitHubCommit>(
                        `/repos/${repoPath}/commits/${encodeURIComponent(commitSha)}`,
                        {
                            signal
                        }
                    );
                    return res.data;
                },
                signal
            );

        if (!prRef) {
            const commit = await getCommit(sha);
            return { subject: extractCommitSubject(commit.commit?.message), author: commit.commit?.author?.name ?? '' };
        }

        // `sha` is the synthetic merge commit; its second parent is the PR head, which carries the real subject/author.
        // If the merge commit can't be read (or isn't a two-parent merge), fall back to the PR's head sha.
        let commit: IGitHubCommit | undefined;
        try {
            const merge = await getCommit(sha);
            const headSha = merge.parents?.length >= 2 ? merge.parents[1].sha : undefined;
            if (headSha) commit = await getCommit(headSha);
        } catch (err) {
            this.logger.warn(`Could not read PR merge/head commit, falling back to the pull request: ${describeGitHubError(err).message}`);
        }
        if (!commit) {
            const prNumber = parsePullNumber(prRef);
            if (prNumber === null) throw new Error(`cannot derive PR number from ref "${prRef}"`);
            const pr = await withInstallationToken(
                this.config,
                repository,
                repoId,
                async token =>
                    (await createGitHubClient(this.urls, token).get<{ head?: { sha?: string } }>(`/repos/${repoPath}/pulls/${prNumber}`, { signal }))
                        .data,
                signal,
                { pull_requests: 'read' }
            );
            if (!pr.head?.sha) throw new Error('pull request response has no head sha');
            commit = await getCommit(pr.head.sha);
        }

        return { subject: extractCommitSubject(commit.commit?.message), author: commit.commit?.author?.name ?? '' };
    }

    // ------------------------------------------------------------------ login

    async getProviderLoginUrl(redirectUri: string, state?: string): Promise<string> {
        const params = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: redirectUri });
        if (state) params.set('state', state);
        return `${this.urls.web}/login/oauth/authorize?${params.toString()}`;
    }

    /** POSTs to the OAuth token endpoint. GitHub reports failures as HTTP 200 with `{error, error_description}`. */
    private async oauthTokenRequest(form: Record<string, string>): Promise<{ access_token: string; expires_in?: number; refresh_token?: string }> {
        let data: { error?: string; error_description?: string; access_token?: string; expires_in?: number; refresh_token?: string };
        try {
            const response = await axios.post(`${this.urls.web}/login/oauth/access_token`, new URLSearchParams(form).toString(), {
                headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'PixelCI' },
                timeout: GITHUB_REQUEST_TIMEOUT_MS
            });
            data = response.data ?? {};
        } catch (err) {
            const info = describeGitHubError(err);
            const body = axios.isAxiosError(err) ? (err.response?.data as { error?: string; error_description?: string } | undefined) : undefined;
            throw new GitHubOAuthError(body?.error ?? 'request_failed', body?.error_description ?? info.message);
        }
        if (data.error) throw new GitHubOAuthError(data.error, data.error_description);
        if (!data.access_token) throw new GitHubOAuthError('invalid_response', 'GitHub did not return an access token');
        return data as { access_token: string; expires_in?: number; refresh_token?: string };
    }

    private sessionFromToken(data: { access_token: string; expires_in?: number; refresh_token?: string }, redirectUri: string): IUserVcsSession {
        const expiring = typeof data.expires_in === 'number' && data.expires_in > 0;
        return {
            accessToken: data.access_token,
            expiresAt: expiring ? Date.now() + data.expires_in! * 1000 : NO_EXPIRY,
            refreshToken: expiring ? (data.refresh_token ?? '') : '',
            redirectUri
        };
    }

    async exchangeProviderCode(redirectUri: string, code: string): Promise<IVcsLoginSessionResponse> {
        let tokenData: Awaited<ReturnType<VcsGitHubService['oauthTokenRequest']>>;
        try {
            tokenData = await this.oauthTokenRequest({
                client_id: this.config.clientId,
                client_secret: this.config.clientSecret,
                code,
                redirect_uri: redirectUri
            });
        } catch (err) {
            if (err instanceof GitHubOAuthError) throw new HttpBadRequestError(err.message);
            throw err;
        }

        const client = createGitHubClient(this.urls, tokenData.access_token);
        let user: { id?: number; login?: string; name?: string | null };
        try {
            user = (await client.get('/user')).data;
        } catch (err) {
            throw new HttpBadRequestError(`Could not read your GitHub profile: ${describeGitHubError(err).message}`);
        }
        if (!user?.id) throw new HttpBadRequestError('GitHub did not return a user id');

        // Anyone on github.com can authorize an OAuth flow; only allow users who can reach at least one installation of the App.
        let installationCount: number;
        try {
            installationCount = (await client.get<{ total_count: number }>('/user/installations', { params: { per_page: 1 } })).data.total_count;
        } catch (err) {
            throw new HttpBadRequestError(`Could not verify GitHub App installations: ${describeGitHubError(err).message}`);
        }
        if (!installationCount) throw new HttpAccessDeniedError('No access to any installation of this GitHub App');

        return {
            id: String(user.id),
            name: user.name || user.login || String(user.id),
            ...this.sessionFromToken(tokenData, redirectUri)
        };
    }

    private async renewToken(user: UserEntity): Promise<void> {
        await ensureFreshVcsSession(
            user,
            async session => {
                if (!session.refreshToken) throw new GitHubOAuthError('no_refresh_token', 'GitHub session expired; please sign in again');
                this.logger.info('Refreshing GitHub token', { userId: user.id });
                const data = await this.oauthTokenRequest({
                    grant_type: 'refresh_token',
                    refresh_token: session.refreshToken,
                    client_id: this.config.clientId,
                    client_secret: this.config.clientSecret
                });
                return { ...this.sessionFromToken(data, session.redirectUri), redirectUri: session.redirectUri };
            },
            err => err instanceof GitHubOAuthError && err.code === 'bad_refresh_token'
        );
    }

    /** Refreshes (if needed) and returns a client for the user; throws HttpBadRequestError when the session can't be used. */
    private async userClient(user: UserEntity) {
        try {
            await this.renewToken(user);
        } catch (err) {
            if (err instanceof HttpBadRequestError) throw err;
            if (err instanceof GitHubOAuthError && err.code === 'request_failed') {
                this.logger.warn('GitHub token refresh request failed', { userId: user.id, error: String(err) });
                throw new GitHubTransientError('Could not refresh your GitHub session; please try again');
            }
            this.logger.warn('GitHub token refresh failed', { userId: user.id, error: String(err) });
            throw new HttpBadRequestError('GitHub session expired; please sign in again');
        }
        return createGitHubClient(this.urls, user.vcsSession!.accessToken);
    }

    // ----------------------------------------------------------------- search

    private mapApiError(err: unknown): never {
        const info = describeGitHubError(err);
        if (info.status === 401) throw new HttpBadRequestError('GitHub session expired; please sign in again');
        throw new HttpBadRequestError(info.message);
    }

    async searchProjects(user: UserEntity, search: string): Promise<IVcsProject[]> {
        const client = await this.userClient(user);
        const cacheKey = `${user.id}:${user.vcsId}`;

        let entries: ISearchEntry[];
        const cached = searchCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            entries = cached.items;
        } else {
            // Coalesce concurrent listings (debounced keystrokes during a slow first listing) per user+integration.
            let pending = searchInFlight.get(cacheKey);
            if (!pending) {
                pending = this.listInstallationRepos(client);
                searchInFlight.set(cacheKey, pending);
                const clear = () => {
                    if (searchInFlight.get(cacheKey) === pending) searchInFlight.delete(cacheKey);
                };
                pending.then(items => {
                    searchCache.set(cacheKey, { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, items });
                    clear();
                }, clear);
            }
            try {
                entries = await pending;
            } catch (err) {
                return this.mapApiError(err);
            }
        }

        const needle = search.trim().toLowerCase();
        return entries
            .filter(e => !needle || e.projectPath.toLowerCase().includes(needle))
            .sort((a, b) => b.pushedAt - a.pushedAt)
            .slice(0, SEARCH_MAX_RESULTS)
            .map(({ pushedAt: _pushedAt, ...project }) => project);
    }

    private async listInstallationRepos(client: ReturnType<typeof createGitHubClient>): Promise<ISearchEntry[]> {
        // One page (100) of installations is plenty; each installation is capped at 10 pages (1000 repos).
        const installations = (await client.get<{ installations: { id: number }[] }>('/user/installations', { params: { per_page: 100, page: 1 } }))
            .data.installations;

        const byId = new Map<number, ISearchEntry>();
        const addAll = (repos: IGitHubRepo[]) => {
            for (const repo of repos) {
                if (byId.has(repo.id)) continue;
                byId.set(repo.id, { ...toProject(repo), pushedAt: repo.pushed_at ? Date.parse(repo.pushed_at) || 0 : 0 });
            }
        };

        await Promise.all(
            installations.map(async inst => {
                const path = `/user/installations/${inst.id}/repositories`;
                const first = (await client.get<{ total_count: number; repositories: IGitHubRepo[] }>(path, { params: { per_page: 100, page: 1 } }))
                    .data;
                addAll(first.repositories ?? []);
                const pages = Math.min(SEARCH_MAX_REPO_PAGES, Math.ceil((first.total_count ?? 0) / 100));
                const rest: Promise<IGitHubRepo[]>[] = [];
                for (let page = 2; page <= pages; page++) {
                    rest.push(
                        client
                            .get<{ repositories: IGitHubRepo[] }>(path, { params: { per_page: 100, page } })
                            .then(res => res.data.repositories ?? [])
                    );
                }
                for (const repos of await Promise.all(rest)) addAll(repos);
            })
        );
        return [...byId.values()];
    }

    async getProjectByPath(user: UserEntity, projectPath: string): Promise<IVcsProject> {
        if (!/^[^/\s]+\/[^/\s]+$/.test(projectPath)) throw new HttpBadRequestError('Project path must look like owner/repo');
        const client = await this.userClient(user);

        let repo: IGitHubRepo;
        try {
            repo = (await client.get<IGitHubRepo>(`/repos/${encodeRepoPath(projectPath)}`)).data;
        } catch (err) {
            const info = describeGitHubError(err);
            if (info.status === 403 || info.status === 404) throw new HttpNotFoundError('Repository not found or no access');
            return this.mapApiError(err);
        }

        if (this.config.appId && this.config.privateKey) {
            try {
                await appJwtGet(this.config, `/repos/${encodeRepoPath(repo.full_name)}/installation`);
            } catch (err) {
                const info = describeGitHubError(err);
                if (info.status === 404) throw new HttpBadRequestError(`The PixelCI GitHub App is not installed on ${repo.full_name}`);
                this.logger.warn(`GitHub App installation check failed: ${info.message}`);
                throw new HttpBadRequestError(`Could not verify the PixelCI GitHub App installation on ${repo.full_name}: ${info.message}`);
            }
        }

        return toProject(repo);
    }

    parseProjectUrl(url: URL): string | null {
        return parseGitHubProjectUrl(this.urls.web, url);
    }

    getCommitUrlBase(projectPath: string): string {
        return `${this.urls.web}/${projectPath}/commit`;
    }

    // ----------------------------------------------------------------- access

    async userCanAccessProject(user: UserEntity, projectIdentifier: string): Promise<boolean> {
        if (!user.vcsSession) return false;
        try {
            await this.renewToken(user);
        } catch (err) {
            this.logger.warn('GitHub token renewal failed during project access check', { userId: user.id, error: String(err) });
            return false;
        }
        return this.checkProjectAccess(user.vcsSession.accessToken, projectIdentifier);
    }

    async tokenCanAccessProject(token: string, projectIdentifier: string): Promise<boolean> {
        return this.checkProjectAccess(token, projectIdentifier);
    }

    private async checkProjectAccess(token: string, projectIdentifier: string): Promise<boolean> {
        const path = /^\d+$/.test(projectIdentifier) ? `/repositories/${projectIdentifier}` : `/repos/${encodeRepoPath(projectIdentifier)}`;
        try {
            const response = await createGitHubClient(this.urls, token).get(path, { validateStatus: () => true });
            if (response.status >= 500) this.logger.warn('GitHub project access check failed', { projectIdentifier, status: response.status });
            return response.status === 200;
        } catch (err) {
            this.logger.warn('GitHub project access check request failed', { projectIdentifier, error: String(err) });
            return false;
        }
    }

    async getUserProjectRole(user: UserEntity, projectIdentifier: string): Promise<IVcsProjectRole> {
        if (!user.vcsSession) return 'none';
        // Token renewal and transport failures propagate: the caller denies without caching a transient error.
        await this.renewToken(user);

        const path = /^\d+$/.test(projectIdentifier) ? `/repositories/${projectIdentifier}` : `/repos/${encodeRepoPath(projectIdentifier)}`;
        const response = await createGitHubClient(this.urls, user.vcsSession.accessToken).get<{ permissions?: unknown; message?: unknown }>(path, {
            validateStatus: () => true
        });
        if (response.status === 200) return githubRoleFromPermissions(response.data?.permissions);

        const message = typeof response.data?.message === 'string' ? response.data.message : '';
        const rateLimited = response.status === 429 || (response.status === 403 && /rate limit/i.test(message));
        if (!rateLimited && (response.status === 401 || response.status === 403 || response.status === 404)) return 'none';
        throw new Error(`GitHub role lookup for ${projectIdentifier} failed with HTTP ${response.status}${message ? `: ${message}` : ''}`);
    }

    async getTokenUser(token: string): Promise<IVcsTokenUser | null> {
        try {
            const response = await createGitHubClient(this.urls, token).get<{ id?: number }>('/user', { validateStatus: () => true });
            if (response.status !== 200) return null; // includes installation tokens (ghs_)
            return response.data?.id ? { id: String(response.data.id) } : null;
        } catch (err) {
            this.logger.warn(`GitHub token validation: request to ${this.urls.api}/user failed (${err})`);
            return null;
        }
    }

    // ------------------------------------------------------------------ rerun

    async rerunCiJob(
        user: UserEntity,
        app: Pick<AppEntity, 'projectPath' | 'vcsProjectId'>,
        ciJobId: string,
        options: IVcsRerunOptions = {}
    ): Promise<IVcsRerunResult> {
        const parsed = parseCiJobId(ciJobId);
        if (!app.vcsProjectId || !parsed) return { ok: false, error: 'No CI run recorded for this build' };

        const runUrl = (fullName: string) => `${this.urls.web}/${fullName}/actions/runs/${parsed.runId}`;
        const expired = (fullName: string): IVcsRerunResult => ({
            ok: false,
            error: `GitHub session expired; please sign in again. Re-run it from GitHub: ${runUrl(fullName)}`
        });
        // Rate limits can arrive as 429 or as 403 (primary: `rateLimited`; secondary: "You have exceeded a secondary rate limit").
        const isTransient = (info: { status?: number; message: string; rateLimited?: boolean }) =>
            info.status === undefined ||
            info.status >= 500 ||
            info.status === 429 ||
            !!info.rateLimited ||
            (info.status === 403 && /rate limit/i.test(info.message));

        let client: ReturnType<typeof createGitHubClient>;
        try {
            client = await this.userClient(user);
        } catch (err) {
            if (err instanceof GitHubTransientError) {
                return {
                    ok: false,
                    retryable: true,
                    error: `Could not refresh your GitHub session. Re-run it from GitHub: ${runUrl(app.projectPath)}`
                };
            }
            return expired(app.projectPath);
        }

        let repo: { full_name: string; permissions?: { push?: boolean } };
        try {
            repo = (await client.get(`/repositories/${app.vcsProjectId}`)).data;
        } catch (err) {
            const info = describeGitHubError(err);
            if (info.status === 401) return expired(app.projectPath);
            if (info.status === 404) return { ok: false, error: 'Repository not accessible (App uninstalled or access lost)' };
            return { ok: false, retryable: isTransient(info), error: `Could not look up the repository on GitHub: ${info.message}` };
        }

        const fullName = repo.full_name;
        const movedProjectPath = fullName !== app.projectPath ? fullName : undefined;
        const withMove = <T extends object>(result: T): T & { movedProjectPath?: string } =>
            movedProjectPath ? { ...result, movedProjectPath } : result;

        if (repo.permissions?.push === false) {
            return withMove({
                ok: false as const,
                error: `You need write access to ${fullName} to re-run its CI jobs. Re-run it from GitHub: ${runUrl(fullName)}`
            });
        }

        const repoPath = encodeRepoPath(fullName);
        const runPath = `/repos/${repoPath}/actions/runs/${parsed.runId}`;
        const getRun = async (): Promise<{ run: { status?: string | null; run_attempt?: number } } | { error: IVcsRerunResult }> => {
            try {
                return { run: (await client.get<{ status?: string | null; run_attempt?: number }>(runPath)).data ?? {} };
            } catch (err) {
                const info = describeGitHubError(err);
                this.logger.warn('GitHub run lookup failed', { runId: parsed.runId, status: info.status, message: info.message });
                if (info.status === 401) return { error: expired(fullName) };
                return {
                    error: {
                        ok: false,
                        retryable: isTransient(info),
                        error: `Could not look up the workflow run on GitHub: ${info.message}. Re-run it from GitHub: ${runUrl(fullName)}`
                    }
                };
            }
        };

        if (options.expectedRunAttempt !== undefined) {
            const res = await getRun();
            if ('error' in res) return withMove(res.error);
            if (res.run.run_attempt !== undefined && res.run.run_attempt !== options.expectedRunAttempt) {
                return withMove({
                    ok: false as const,
                    superseded: true as const,
                    error: 'The workflow run was re-run since this re-run was scheduled'
                });
            }
        }

        const attempts: string[] = [];
        if (parsed.jobId) attempts.push(`/repos/${repoPath}/actions/jobs/${parsed.jobId}/rerun`);
        attempts.push(`/repos/${repoPath}/actions/runs/${parsed.runId}/rerun-failed-jobs`);

        let lastError: { status?: number; message: string; rateLimited?: boolean } = { message: 'unknown error' };
        for (let i = 0; i < attempts.length; i++) {
            try {
                await client.post(attempts[i], {});
                return withMove({ ok: true as const, url: runUrl(fullName) });
            } catch (err) {
                const info = describeGitHubError(err);
                lastError = info;
                this.logger.warn(`GitHub re-run request failed (${attempts[i]})`, { status: info.status, message: info.message });
                if (info.status === 401) return withMove(expired(fullName));

                // GitHub refuses a re-run with 403 "This workflow is already running" while jobs of the run are in progress.
                if ((info.status === 403 || info.status === 409 || info.status === 422) && /already running/i.test(info.message)) {
                    const res = await getRun();
                    if ('error' in res) return withMove(res.error);
                    if (res.run.status && res.run.status !== 'completed') {
                        return withMove({
                            ok: false as const,
                            deferred: true as const,
                            url: runUrl(fullName),
                            runAttempt: res.run.run_attempt,
                            error: `The workflow run is still in progress: ${info.message.replace(/[.\s]+$/, '')}`
                        });
                    }
                }

                // Only 4xx on the job-level call falls through to the run-level fallback.
                const canFallback = i < attempts.length - 1 && info.status !== undefined && info.status >= 400 && info.status < 500;
                if (!canFallback) break;
            }
        }

        const status = lastError.status !== undefined ? ` (HTTP ${lastError.status})` : '';
        const message = lastError.message.replace(/[.\s]+$/, '');
        return withMove({
            ok: false as const,
            retryable: isTransient(lastError),
            error: `GitHub refused to re-run the job${status}: ${message}. Re-run it from GitHub: ${runUrl(fullName)}`
        });
    }
}

interface IGitHubCommit {
    parents: { sha: string }[];
    commit?: { message?: string; author?: { name?: string } };
}
