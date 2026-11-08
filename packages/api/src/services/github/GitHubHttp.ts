import axios, { AxiosInstance, isAxiosError } from 'axios';

export const GITHUB_DEFAULT_WEB_URL = 'https://github.com';
export const GITHUB_API_VERSION = '2022-11-28';
export const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

export interface IGitHubUrls {
    /** Web base URL without trailing slash, e.g. https://github.com or https://ghe.example.com */
    web: string;
    /** REST API base URL without trailing slash */
    api: string;
}

/** Resolves the web and REST API bases: github.com uses api.github.com; Enterprise Server uses `{url}/api/v3`. */
export function githubUrls(config: { url?: string }): IGitHubUrls {
    const web = (config.url?.trim() || GITHUB_DEFAULT_WEB_URL).replace(/\/+$/, '');
    const api = web === GITHUB_DEFAULT_WEB_URL ? 'https://api.github.com' : `${web}/api/v3`;
    return { web, api };
}

export function githubHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'PixelCI'
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

/** Axios client for the REST API of the given bases. Non-2xx responses throw unless `validateStatus` is overridden per call. */
export function createGitHubClient(urls: IGitHubUrls, token?: string): AxiosInstance {
    return axios.create({ baseURL: urls.api, headers: githubHeaders(token), timeout: GITHUB_REQUEST_TIMEOUT_MS });
}

export interface IGitHubErrorInfo {
    /** HTTP status; undefined for network errors and timeouts */
    status?: number;
    message: string;
    rateLimited: boolean;
}

/** Flattens an axios/other error into a status and a human message. GitHub's own `message` is passed through verbatim. */
export function describeGitHubError(err: unknown): IGitHubErrorInfo {
    if (isAxiosError(err)) {
        const status = err.response?.status;
        const remaining = err.response?.headers?.['x-ratelimit-remaining'];
        const rateLimited = (status === 403 || status === 429) && String(remaining) === '0';
        if (rateLimited) return { status, message: 'GitHub API rate limit exceeded', rateLimited };
        const data = err.response?.data as { message?: unknown } | undefined;
        const message = typeof data?.message === 'string' && data.message ? data.message : err.message;
        return { status, message, rateLimited: false };
    }
    return { message: err instanceof Error ? err.message : String(err), rateLimited: false };
}

/** `owner/repo` -> URL path segment pair, each encoded. */
export function encodeRepoPath(fullName: string): string {
    return fullName.split('/').map(encodeURIComponent).join('/');
}
