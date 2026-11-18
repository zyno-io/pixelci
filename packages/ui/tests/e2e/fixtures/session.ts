import type { Page } from '@playwright/test';

// The seeded user's session JWT (zero ID, valid until 2049).
export const E2E_JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhcHAiLCJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjI1MjQ2MDc5OTksImlhdCI6MTc0NzYzMjc2Mn0.7FmHrOWWRWmH8i8floyAE-VvYu4Lya_9c-Qy68r8puI';

/** Signs the page's browser context in with the session cookie (the e2e API runs with an http PUBLIC_URL, so the cookie is not `__Host-`). */
export async function signIn(page: Page) {
    await page.context().addCookies([{ name: 'pixelci_session', value: E2E_JWT, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
}
