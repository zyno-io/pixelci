import { HttpBadRequestError } from '@zyno-io/ts-server-foundation';

import { IUserVcsSession, UserEntity } from '../entities/User.entity';
import { SecretUnreadableError } from './secrets/SecretBox';
import { openVcsSession, sealVcsSession, SIGN_IN_AGAIN } from './secrets/VcsSecrets';

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
    const current = stored?.vcsSession ?? callerSession; // sealed
    if (isFresh(current)) return current;

    const currentOpen = openVcsSession(userId, current);
    try {
        const sealed = sealVcsSession(userId, await refreshFn(currentOpen));
        await UserEntity.query().filter({ id: userId }).patchMany({ vcsSession: sealed });
        return sealed;
    } catch (err) {
        if (isInvalidGrant(err)) {
            // Refresh tokens are single-use: a concurrent process (replica) may have rotated it. Adopt its result.
            // Compare opened tokens: two seals of the same plaintext differ.
            const reread = await UserEntity.query().filter({ id: userId }).findOneOrUndefined();
            const adopted = reread?.vcsSession;
            if (adopted && isFresh(adopted) && openVcsSession(userId, adopted).refreshToken !== currentOpen.refreshToken) return adopted;
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

    try {
        user.vcsSession = await pending; // stays sealed in memory, so a later save() never writes plaintext
    } catch (err) {
        // A session sealed with a key that is no longer configured is unusable: the user must sign in again.
        if (err instanceof SecretUnreadableError) throw new HttpBadRequestError(SIGN_IN_AGAIN);
        throw err;
    }
}
