import { HttpBadRequestError } from '@zyno-io/ts-server-foundation';
import { createPrivateKey } from 'crypto';

import type {
    IGitHubConfigInput,
    IVcsIntegrationCreateInput,
    IVcsIntegrationDetailResponse,
    IVcsIntegrationUpdateInput
} from '../controllers/VcsIntegrations.controller';

import { IGitHubConfig, IGitLabConfig, VcsIntegrationEntity } from '../entities/VcsIntegration.entity';

const GITHUB_DEFAULT_URL = 'https://github.com';

type IPlatform = VcsIntegrationEntity['platform'];
export type IVcsConfig = IGitLabConfig | IGitHubConfig;

function trimStr(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function stripTrailingSlashes(v: string): string {
    return v.replace(/\/+$/, '');
}

/** Trims, strips trailing slashes from url/oidcAudience, drops url when it is the github.com default. */
function normalizeGitHubConfig(config: Partial<IGitHubConfigInput>): IGitHubConfig {
    const url = stripTrailingSlashes(trimStr(config.url));
    const oidcIssuer = trimStr(config.oidcIssuer);
    const normalized: IGitHubConfig = {
        clientId: trimStr(config.clientId),
        clientSecret: trimStr(config.clientSecret),
        oidcAudience: stripTrailingSlashes(trimStr(config.oidcAudience))
    };
    if (url && url !== GITHUB_DEFAULT_URL) normalized.url = url;
    if (oidcIssuer) normalized.oidcIssuer = oidcIssuer;
    const appId = trimStr(config.appId);
    if (appId) normalized.appId = appId;
    // PEM: only trim the ends; internal newlines are significant
    const privateKey = typeof config.privateKey === 'string' ? config.privateKey.trim() : '';
    if (privateKey) normalized.privateKey = privateKey;
    return normalized;
}

function validateGitHubConfig(config: IGitHubConfig, requireAppCredentials = true): void {
    if (!config.clientId) throw new HttpBadRequestError('clientId is required');
    if (!config.clientSecret) throw new HttpBadRequestError('clientSecret is required');
    if (!config.oidcAudience) throw new HttpBadRequestError('oidcAudience is required');
    if (requireAppCredentials && !config.appId) throw new HttpBadRequestError('appId is required');
    if (config.appId && !/^\d+$/.test(config.appId)) throw new HttpBadRequestError('appId must be numeric');
    if (requireAppCredentials && !config.privateKey) throw new HttpBadRequestError('privateKey is required');
    if (config.privateKey) {
        try {
            createPrivateKey(config.privateKey);
        } catch {
            throw new HttpBadRequestError('privateKey is not a valid PEM private key');
        }
    }
    if (config.url) {
        let parsed: URL;
        try {
            parsed = new URL(config.url);
        } catch {
            throw new HttpBadRequestError('url is not a valid URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new HttpBadRequestError('url must be http(s)');
    }
}

export function normalizeCreateConfig(input: IVcsIntegrationCreateInput): { platform: IPlatform; config: IVcsConfig } {
    if (input.platform === 'github') {
        const config = normalizeGitHubConfig(input.config);
        validateGitHubConfig(config);
        return { platform: 'github', config };
    }
    if (input.platform === 'gitlab') {
        // GitLab config is stored exactly as before.
        return { platform: 'gitlab', config: input.config };
    }
    throw new HttpBadRequestError('Unsupported platform');
}

/**
 * Merges an update onto a stored config. Absent keys keep the stored value; empty clientSecret/privateKey keep
 * the stored value; an empty GitHub `url` removes it. `platform` is the stored integration's platform.
 */
export function mergeConfigUpdate(platform: IPlatform, stored: IVcsConfig, update: NonNullable<IVcsIntegrationUpdateInput['config']>): IVcsConfig {
    const patch = update as Record<string, unknown>;

    if (platform === 'gitlab') {
        const merged = { ...(stored as IGitLabConfig) };
        if (patch.url !== undefined) merged.url = patch.url as string;
        if (patch.clientId !== undefined) merged.clientId = patch.clientId as string;
        if (typeof patch.clientSecret === 'string' && patch.clientSecret !== '') merged.clientSecret = patch.clientSecret;
        return merged;
    }

    const base = stored as IGitHubConfig;
    const merged: Partial<IGitHubConfigInput> = { ...base };
    for (const key of ['url', 'clientId', 'appId', 'oidcAudience', 'oidcIssuer'] as const) {
        if (patch[key] !== undefined) merged[key] = patch[key] as string;
    }
    if (typeof patch.clientSecret === 'string' && patch.clientSecret !== '') merged.clientSecret = patch.clientSecret;
    if (typeof patch.privateKey === 'string' && patch.privateKey.trim() !== '') merged.privateKey = patch.privateKey;

    const config = normalizeGitHubConfig(merged);
    // Rows created before appId/privateKey existed may lack them; only insist once either is configured.
    validateGitHubConfig(config, !!(base.appId || base.privateKey || patch.appId || patch.privateKey));
    return config;
}

/** Secrets never leave the server: GitLab drops clientSecret; GitHub drops clientSecret/privateKey. */
export function redactConfig(platform: IPlatform, id: string, name: string, config: IVcsConfig): IVcsIntegrationDetailResponse {
    if (platform === 'github') {
        const c = config as IGitHubConfig;
        const detail: Extract<IVcsIntegrationDetailResponse, { platform: 'github' }> = {
            id,
            name,
            platform: 'github',
            config: { clientId: c.clientId, oidcAudience: c.oidcAudience, hasPrivateKey: !!c.privateKey }
        };
        if (c.url) detail.config.url = c.url;
        if (c.appId) detail.config.appId = c.appId;
        return detail;
    }
    const c = config as IGitLabConfig;
    return { id, name, platform: 'gitlab', config: { url: c.url, clientId: c.clientId } };
}
