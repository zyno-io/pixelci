import { HttpBadRequestError } from '@zyno-io/ts-server-foundation';

import { IUserVcsSession, UserEntity } from '../entities/User.entity';

/** Refresh this long before the access token actually expires. */
export const VCS_SESSION_REFRESH_SKEW_MS = 5 * 60_000;

const inflight = new Map<string, Promise<IUserVcsSession>>();

function isFresh(session: IUserVcsSession): boolean {
    return session.expiresAt - VCS_SESSION_REFRESH_SKEW_MS > Date.now();
}

async function refreshOnce(
    userId: string,
    callerSession: IUserVcsSession,
    refreshFn: (session: IUserVcsSession) => Promise<IUserVcsSession>,
    isInvalidGrant: (err: unknown) => boolean
): Promise<IUserVcsSession> {
    // Another request or process may have refreshed already.
    const stored = await UserEntity.query().filter({ id: userId }).findOneOrUndefined();
    const current = stored?.vcsSession ?? callerSession;
    if (isFresh(current)) return current;

    try {
        const refreshed = await refreshFn(current);
        await UserEntity.query().filter({ id: userId }).patchMany({ vcsSession: refreshed });
        return refreshed;
    } catch (err) {
        if (isInvalidGrant(err)) {
            // Refresh tokens are single-use: a concurrent process (replica) may have rotated it. Adopt its result.
            const reread = await UserEntity.query().filter({ id: userId }).findOneOrUndefined();
            const adopted = reread?.vcsSession;
            if (adopted && adopted.refreshToken !== current.refreshToken && isFresh(adopted)) return adopted;
        }
        throw err;
    }
}

/**
 * Ensures `user.vcsSession` has a usable access token, refreshing it when it is expired or about to expire.
 * Concurrent calls for the same user share one refresh (providers like GitHub issue single-use refresh tokens).
 * The caller's `user` object is updated in place.
 */
export async function ensureFreshVcsSession(
    user: UserEntity,
    refreshFn: (session: IUserVcsSession) => Promise<IUserVcsSession>,
    isInvalidGrant: (err: unknown) => boolean = () => false
): Promise<void> {
    const session = user.vcsSession;
    if (!session) throw new HttpBadRequestError('No VCS session available; please sign in again');
    if (isFresh(session)) return;

    let pending = inflight.get(user.id);
    if (!pending) {
        pending = refreshOnce(user.id, session, refreshFn, isInvalidGrant).finally(() => {
            inflight.delete(user.id);
        });
        inflight.set(user.id, pending);
    }

    user.vcsSession = await pending;
}
