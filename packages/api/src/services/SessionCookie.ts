import type { HttpRequest, HttpResponse } from '@zyno-io/ts-server-foundation';

import type { AppConfig } from '../config';

export interface ISessionCookieSettings {
    name: string;
    secure: boolean;
    maxAgeSeconds: number;
}

const JWT_SHAPED_RE = /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/;

/** The origin users visit, or undefined when PUBLIC_URL is unset or not an http(s) URL. */
export function publicOrigin(config: Pick<AppConfig, 'PUBLIC_URL'>): string | undefined {
    const publicUrl = config.PUBLIC_URL?.trim();
    if (!publicUrl) return undefined;
    try {
        const parsed = new URL(publicUrl);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The cookie is Secure (and uses the `__Host-` prefix, which browsers only honour for Secure, Path=/, Domain-less cookies) exactly when
 * PUBLIC_URL is https; browsers don't store Secure cookies from plain-http origins, so local dev uses the bare name.
 */
export function sessionCookieSettings(config: Pick<AppConfig, 'PUBLIC_URL' | 'AUTH_JWT_EXPIRATION_MINS'>): ISessionCookieSettings {
    const secure = publicOrigin(config)?.startsWith('https:') ?? false;
    return {
        name: secure ? '__Host-pixelci_session' : 'pixelci_session',
        secure,
        maxAgeSeconds: (config.AUTH_JWT_EXPIRATION_MINS ?? 60) * 60
    };
}

function attributes(settings: ISessionCookieSettings, maxAge: number): string {
    return ['Path=/', 'HttpOnly', ...(settings.secure ? ['Secure'] : []), 'SameSite=Lax', `Max-Age=${maxAge}`].join('; ');
}

export function serializeSessionCookie(settings: ISessionCookieSettings, jwt: string): string {
    return `${settings.name}=${jwt}; ${attributes(settings, settings.maxAgeSeconds)}`;
}

export function serializeClearedSessionCookie(settings: ISessionCookieSettings): string {
    return `${settings.name}=; ${attributes(settings, 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** The first cookie with the exact session name, if it is JWT-shaped. Anything else (including other names such as `jwt`) is ignored. */
export function readSessionCookie(request: HttpRequest, settings: ISessionCookieSettings): string | undefined {
    const header = request.headers.cookie;
    if (typeof header !== 'string') return undefined;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0 || part.slice(0, eq).trim() !== settings.name) continue;
        const value = part.slice(eq + 1).trim();
        return JWT_SHAPED_RE.test(value) ? value : undefined;
    }
    return undefined;
}

export function appendSetCookie(response: HttpResponse, value: string): void {
    const existing = response.getHeader('set-cookie');
    if (existing === undefined) response.setHeader('set-cookie', value);
    else response.setHeader('set-cookie', [...(Array.isArray(existing) ? existing : [String(existing)]), value]);
}
