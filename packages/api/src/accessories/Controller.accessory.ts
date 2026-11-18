import { http, HttpUnauthorizedError } from '@zyno-io/ts-server-foundation';
import { createCachingParameterResolver } from '@zyno-io/ts-server-foundation';

import { UserEntity } from '../entities/User.entity';
import { getSessionAuth, SessionMiddleware } from './Session.accessory';

/**
 * Resolvers
 */
export const UserResolver = createCachingParameterResolver(UserEntity, async context => {
    const auth = await getSessionAuth(context.request);
    if (!auth) throw new HttpUnauthorizedError();
    return auth.user;
});

/**
 * Decorators
 */
export function ApiController(path?: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function <T extends { new (...args: any[]): unknown }>(target: T) {
        http.controller(path)(target);
        http.resolveParameter(UserEntity, UserResolver)(target);
        http.middleware(SessionMiddleware)(target);
        return target;
    };
}
