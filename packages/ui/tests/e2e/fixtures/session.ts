import type { Page } from '@playwright/test';

import { createHmac } from 'node:crypto';

const ZERO_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * A session JWT for the seeded user, signed with the dev AUTH_JWT_SECRET. It is minted per call, with `authTime` now: logging out
 * revokes every session issued before it, so a token fixed in advance would stop working once any test signs out.
 */
export function mintSessionJwt(): string {
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const now = Date.now();
    const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'app', sub: ZERO_USER_ID, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, authTime: now })}`;
    return `${body}.${createHmac('sha256', process.env.AUTH_JWT_SECRET ?? 'secret')
        .update(body)
        .digest('base64url')}`;
}

/** Signs the page's browser context in with the session cookie (the e2e API runs with an http PUBLIC_URL, so the cookie is not `__Host-`). */
export async function signIn(page: Page) {
    await page
        .context()
        .addCookies([{ name: 'pixelci_session', value: mintSessionJwt(), domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
}

/** Stubs the logout endpoint (the real one revokes every session of the shared seeded user, breaking tests running in parallel). */
export async function stubLogout(page: Page) {
    let hits = 0;
    await page.route('**/api/session/logout', route => {
        hits++;
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'set-cookie': 'pixelci_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax' },
            body: '{"ok":true}'
        });
    });
    return () => hits;
}
