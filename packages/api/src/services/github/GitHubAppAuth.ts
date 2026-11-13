import { createPrivateKey } from 'crypto';
import { SignJWT } from 'jose';

import { BoundedTtlCache } from '../../helpers/BoundedTtlCache';
import { createGitHubClient, encodeRepoPath, githubUrls } from './GitHubHttp';

export interface IGitHubAppConfig {
    url?: string;
    appId?: string;
    privateKey?: string;
}

const INSTALLATION_ID_TTL_MS = 60 * 60_000;
const TOKEN_EARLY_EXPIRY_MS = 5 * 60_000;

const installationIdCache = new BoundedTtlCache<number>(1_000, INSTALLATION_ID_TTL_MS);
const installationTokenCache = new BoundedTtlCache<Promise<{ token: string; expiresAt: number }>>(1_000, 60 * 60_000);

export function clearGitHubAppCaches(): void {
    installationIdCache.clear();
    installationTokenCache.clear();
}

/**
 * Signs a GitHub App JWT (RS256). GitHub issues PKCS#1 keys (`BEGIN RSA PRIVATE KEY`), which jose's `importPKCS8`
 * rejects, so the key goes through `crypto.createPrivateKey` and the KeyObject is handed to jose.
 * `iat` is backdated 60s for clock drift; lifetime is 10 minutes max (here 600s from iat).
 */
export async function signAppJwt(config: IGitHubAppConfig, nowMs = Date.now()): Promise<string> {
    if (!config.appId || !config.privateKey) throw new Error('GitHub App credentials (appId, privateKey) are not configured');
    const now = Math.floor(nowMs / 1000);
    return new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(config.appId)
        .setIssuedAt(now - 60)
        .setExpirationTime(now + 540)
        .sign(createPrivateKey(config.privateKey));
}

/** GET an API path authenticated as the App itself. */
export async function appJwtGet<T = unknown>(config: IGitHubAppConfig, path: string, signal?: AbortSignal): Promise<T> {
    const jwt = await signAppJwt(config);
    const response = await createGitHubClient(githubUrls(config), jwt).get<T>(path, { signal });
    return response.data;
}

async function getInstallationId(config: IGitHubAppConfig, repository: string, repoId: number, signal?: AbortSignal): Promise<number> {
    const key = `${githubUrls(config).api}|${config.appId}|${repoId}`;
    const cached = installationIdCache.get(key);
    if (cached !== undefined) return cached;

    const data = await appJwtGet<{ id: number }>(config, `/repos/${encodeRepoPath(repository)}/installation`, signal);
    installationIdCache.set(key, data.id);
    return data.id;
}

/** Contents:read installation token scoped to a single repository; cached until 5 minutes before it expires. */
export type IInstallationPermissions = Record<string, 'read' | 'write'>;
const DEFAULT_PERMISSIONS: IInstallationPermissions = { contents: 'read' };

function permissionsKey(permissions: IInstallationPermissions): string {
    return Object.keys(permissions)
        .sort()
        .map(k => `${k}=${permissions[k]}`)
        .join(',');
}

export async function getInstallationToken(
    config: IGitHubAppConfig,
    repository: string,
    repoId: number,
    signal?: AbortSignal,
    permissions: IInstallationPermissions = DEFAULT_PERMISSIONS
): Promise<string> {
    const urls = githubUrls(config);
    const idKey = `${urls.api}|${config.appId}|${repoId}`;
    const key = `${urls.api}|${config.appId}|${repoId}|${permissionsKey(permissions)}`;

    const cached = installationTokenCache.get(key);
    if (cached) {
        try {
            const entry = await cached;
            if (entry.expiresAt - TOKEN_EARLY_EXPIRY_MS > Date.now()) return entry.token;
        } catch {
            // fall through to a fresh request
        }
        installationTokenCache.delete(key);
    }

    const pending = (async () => {
        const installationId = await getInstallationId(config, repository, repoId, signal);
        const jwt = await signAppJwt(config);
        try {
            const response = await createGitHubClient(urls, jwt).post<{ token: string; expires_at: string }>(
                `/app/installations/${installationId}/access_tokens`,
                { repository_ids: [repoId], permissions },
                { signal }
            );
            return { token: response.data.token, expiresAt: Date.parse(response.data.expires_at) || Date.now() + 55 * 60_000 };
        } catch (err) {
            installationIdCache.delete(idKey);
            throw err;
        }
    })();
    installationTokenCache.set(key, pending);
    pending.catch(() => {
        if (installationTokenCache.get(key) === pending) installationTokenCache.delete(key);
    });
    return (await pending).token;
}

export function dropInstallationToken(config: IGitHubAppConfig, repoId: number, permissions: IInstallationPermissions = DEFAULT_PERMISSIONS): void {
    installationTokenCache.delete(`${githubUrls(config).api}|${config.appId}|${repoId}|${permissionsKey(permissions)}`);
}

/** Runs `fn` with an installation token; on a 401 the cached token is dropped and `fn` is retried once. */
export async function withInstallationToken<T>(
    config: IGitHubAppConfig,
    repository: string,
    repoId: number,
    fn: (token: string) => Promise<T>,
    signal?: AbortSignal,
    permissions: IInstallationPermissions = DEFAULT_PERMISSIONS
): Promise<T> {
    const token = await getInstallationToken(config, repository, repoId, signal, permissions);
    try {
        return await fn(token);
    } catch (err) {
        if ((err as { response?: { status?: number } })?.response?.status !== 401) throw err;
        dropInstallationToken(config, repoId, permissions);
        return fn(await getInstallationToken(config, repository, repoId, signal, permissions));
    }
}
