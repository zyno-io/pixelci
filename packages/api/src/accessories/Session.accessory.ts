import {
    getAppConfig,
    getOrCacheValue,
    HttpAccessDeniedError,
    HttpMiddleware,
    HttpRequest,
    HttpResponse,
    HttpUnauthorizedError,
    JWT,
    ParsedJwt,
    ScopedLogger
} from '@zyno-io/ts-server-foundation';

import { AppConfig } from '../config';
import { UserEntity } from '../entities/User.entity';
import { appendSetCookie, publicOrigin, readSessionCookie, serializeSessionCookie, sessionCookieSettings } from '../services/SessionCookie';
import { VcsService } from '../services/Vcs.service';

export interface ISessionAuth {
    jwt: ParsedJwt;
    via: 'bearer' | 'cookie';
}

const BEARER_RE = /^bearer\s+(\S+)$/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const sessionAuthKey = { kind: 'pixelci-session-auth' };

function hasBearerHeader(request: HttpRequest): boolean {
    return BEARER_RE.test(String(request.headers.authorization ?? '').trim());
}

/**
 * The session JWT of a request: `Authorization: Bearer` first, otherwise PixelCI's own session cookie. TSF's `jwt` cookie fallback is
 * deliberately never consulted. Throws 401 for a present but invalid token; undefined when there is none.
 */
export async function getSessionAuth(request: HttpRequest): Promise<ISessionAuth | undefined> {
    return getOrCacheValue(request, sessionAuthKey, async (): Promise<ISessionAuth | undefined> => {
        const bearer = BEARER_RE.exec(String(request.headers.authorization ?? '').trim());
        const token = bearer ? bearer[1] : readSessionCookie(request, sessionCookieSettings(getAppConfig(AppConfig)));
        if (!token) return undefined;
        const jwt = await JWT.process(token);
        if (!jwt.isValid) throw new HttpUnauthorizedError();
        return { jwt, via: bearer ? 'bearer' : 'cookie' };
    });
}

/** Writes a fresh session cookie for the user. `authTime` is when the user actually signed in (kept across renewals). */
export async function issueSession(
    response: HttpResponse,
    config: Pick<AppConfig, 'PUBLIC_URL' | 'AUTH_JWT_EXPIRATION_MINS'>,
    userId: string,
    authTime = Math.floor(Date.now() / 1000)
): Promise<void> {
    const jwt = await JWT.generate({ subject: userId, payload: { authTime } });
    appendSetCookie(response, serializeSessionCookie(sessionCookieSettings(config), jwt));
}

/**
 * Whether a browser request came from PixelCI's own pages. Browsers always send `Sec-Fetch-Site` and/or `Origin` on unsafe requests, and
 * scripts cannot forge them; non-browser clients send neither (and have no ambient cookie to abuse).
 */
export function isFirstPartyRequest(request: HttpRequest, origin: string | undefined): boolean {
    const site = request.headers['sec-fetch-site'];
    if (site === 'same-origin') return true;
    const requestOrigin = request.headers.origin;
    if (requestOrigin !== undefined) return origin !== undefined && requestOrigin === origin;
    return site === undefined || site === 'none';
}

/**
 * On every ApiController: CSRF protection for the session cookie, then sliding renewal of it. Requests carrying a Bearer header are not
 * affected (a header cannot be attached cross-site without CORS, which PixelCI does not grant for these routes).
 */
export class SessionMiddleware extends HttpMiddleware {
    constructor(
        private appConfig: AppConfig,
        private vcsService: VcsService,
        private logger: ScopedLogger
    ) {
        super();
    }

    async handle(request: HttpRequest, response: HttpResponse) {
        if (!SAFE_METHODS.has(request.method ?? 'GET') && !hasBearerHeader(request)) {
            if (!isFirstPartyRequest(request, publicOrigin(this.appConfig))) throw new HttpAccessDeniedError('Cross-site request refused');
        }
        try {
            await this.renew(request, response);
        } catch (err) {
            // A stale or broken cookie must never break a route (public routes included).
            if (err instanceof HttpUnauthorizedError) return;
            this.logger.warn('Session renewal skipped', { error: err instanceof Error ? err.message : String(err) });
        }
    }

    private async renew(request: HttpRequest, response: HttpResponse) {
        if (hasBearerHeader(request)) return;
        const auth = await getSessionAuth(request);
        if (auth?.via !== 'cookie') return;

        const { jwt } = auth;
        const nowMs = Date.now();
        if (jwt.expiresAtMs - nowMs >= (jwt.expiresAtMs - jwt.issuedAtMs) / 2) return;

        const claimed = (jwt.payload as { authTime?: unknown }).authTime;
        const authTime = typeof claimed === 'number' ? claimed : Math.floor(jwt.issuedAtMs / 1000);
        if (nowMs / 1000 - authTime > this.appConfig.SESSION_MAX_AGE_HOURS * 3600) return;

        const user = await UserEntity.query().filter({ id: jwt.subject }).findOneOrUndefined();
        if (!user) return;
        if (this.appConfig.ENFORCE_VCS_PROJECT_ACCESS && (await this.vcsService.checkUserSession(user)) !== 'ok') return;

        await issueSession(response, this.appConfig, user.id, authTime);
    }
}
