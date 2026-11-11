import { HttpBadRequestError } from '@zyno-io/ts-server-foundation';

import { IUserVcsSession, UserEntity } from '../../entities/User.entity';
import { IGitHubConfig, IGitLabConfig } from '../../entities/VcsIntegration.entity';
import { getSecretBox, SecretUnreadableError } from './SecretBox';

type IConfig = IGitLabConfig | IGitHubConfig;

export const integrationSecretCtx = (id: string, field: 'clientSecret' | 'privateKey') => `vcsIntegrations/${id}/${field}`;
export const sessionSecretCtx = (userId: string, field: 'accessToken' | 'refreshToken') => `users/${userId}/vcsSession/${field}`;

/** Seals clientSecret and (when present) privateKey. Returns a copy. */
export function sealIntegrationConfig<T extends IConfig>(id: string, _platform: 'gitlab' | 'github', cfg: T): T {
    const box = getSecretBox();
    const out: Record<string, unknown> = { ...cfg };
    for (const field of ['clientSecret', 'privateKey'] as const) {
        if (typeof out[field] === 'string') out[field] = box.seal(out[field] as string, integrationSecretCtx(id, field));
    }
    return out as T;
}

/** Returns a plaintext copy of the stored config; never assign the result back to the entity. */
export function openIntegrationConfig<T extends IConfig>(integration: { id: string; config: T }, unreadable?: string[]): T {
    const box = getSecretBox();
    const out: Record<string, unknown> = { ...integration.config };
    for (const field of ['clientSecret', 'privateKey'] as const) {
        if (typeof out[field] !== 'string') continue;
        try {
            out[field] = box.open(out[field] as string, integrationSecretCtx(integration.id, field));
        } catch (err) {
            // With `unreadable` supplied (lost-key recovery), an unreadable field becomes '' and is reported instead of throwing.
            if (!unreadable || !(err instanceof SecretUnreadableError)) throw err;
            out[field] = '';
            unreadable.push(field);
        }
    }
    return out as T;
}

export function sealVcsSession(userId: string, s: IUserVcsSession): IUserVcsSession {
    const box = getSecretBox();
    return {
        ...s,
        accessToken: box.seal(s.accessToken, sessionSecretCtx(userId, 'accessToken')),
        refreshToken: box.seal(s.refreshToken, sessionSecretCtx(userId, 'refreshToken'))
    };
}

export function openVcsSession(userId: string, s: IUserVcsSession): IUserVcsSession {
    const box = getSecretBox();
    return {
        ...s,
        accessToken: box.open(s.accessToken, sessionSecretCtx(userId, 'accessToken')),
        refreshToken: box.open(s.refreshToken, sessionSecretCtx(userId, 'refreshToken'))
    };
}

export const SIGN_IN_AGAIN = 'No VCS session available; please sign in again';

/** Plaintext access token for a user whose (sealed) session is held in memory. An unreadable session counts as no session. */
export function vcsAccessToken(user: Pick<UserEntity, 'id' | 'vcsSession'>): string {
    if (!user.vcsSession) throw new HttpBadRequestError(SIGN_IN_AGAIN);
    try {
        return getSecretBox().open(user.vcsSession.accessToken, sessionSecretCtx(user.id, 'accessToken'));
    } catch (err) {
        if (err instanceof SecretUnreadableError) throw new HttpBadRequestError(SIGN_IN_AGAIN);
        throw err;
    }
}
