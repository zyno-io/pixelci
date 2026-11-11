import { expect, Page, Route, test } from '@playwright/test';

// All API traffic is mocked with page.route: no DB writes, no dependency on the shared seed state,
// and no screenshots (so the visual regression screen set is unchanged).

const JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhcHAiLCJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjI1MjQ2MDc5OTksImlhdCI6MTc0NzYzMjc2Mn0.7FmHrOWWRWmH8i8floyAE-VvYu4Lya_9c-Qy68r8puI';

const GITLAB = { id: 'vcs-gitlab', name: 'Mock GitLab', platform: 'gitlab' };
const GITHUB = { id: 'vcs-github', name: 'Mock GitHub', platform: 'github' };
const AUDIENCE = 'https://pixelci.mock.test';

function json(route: Route, body: unknown, status = 200) {
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockApi(page: Page, opts: { authenticated?: boolean; providers?: unknown[]; integrations?: unknown[] } = {}) {
    const { authenticated = true, providers = [GITLAB, GITHUB], integrations = [GITLAB, GITHUB] } = opts;
    const requests: { method: string; path: string; body: unknown }[] = [];

    if (authenticated) {
        await page.addInitScript(jwt => window.localStorage.setItem('pixelci:jwt', jwt), JWT);
    }

    await page.route(/\/api\//, route => {
        const req = route.request();
        const path = new URL(req.url()).pathname;
        const method = req.method();
        if (method === 'OPTIONS') return route.fallback();
        const body = req.postData() ? JSON.parse(req.postData()!) : undefined;
        requests.push({ method, path, body });

        if (path === '/api/session/onboarding-status') return json(route, { isOnboarded: true, setupEnabled: true });
        if (path === '/api/session/me') {
            return authenticated
                ? json(route, { id: 'u1', vcsId: GITHUB.id, name: 'Mock Admin', isAdmin: true })
                : json(route, { message: 'Unauthorized' }, 401);
        }
        if (path === '/api/session/providers') return json(route, providers);
        if (path === '/api/admin/vcs-integrations') {
            return method === 'POST' ? json(route, { id: 'new', ...body }) : json(route, integrations);
        }
        if (path === `/api/admin/vcs-integrations/${GITHUB.id}`) {
            return json(route, {
                ...GITHUB,
                config: { clientId: 'cid', appId: '12345', oidcAudience: AUDIENCE, hasPrivateKey: true }
            });
        }
        if (path === '/api/apps' && method === 'GET') return json(route, []);
        if (path === '/api/apps' && method === 'POST') return json(route, { id: 'app-mock-1', name: body.name, buildCount: 0 });
        if (path === '/api/apps/vcs-projects/search') {
            return json(route, [{ id: '3000000001', name: 'Mock Repo', projectPath: 'acme/mock-repo', defaultBranch: 'main' }]);
        }
        return json(route, {});
    });

    return requests;
}

test.describe('GitHub UI', () => {
    test('admin can add a GitHub integration', async ({ page }) => {
        const requests = await mockApi(page);
        await page.goto('/admin/vcs-integrations');

        await page.getByRole('button', { name: 'Add Integration' }).click();
        await page.locator('select').selectOption('github');

        await expect(page.getByText('GitHub Enterprise URL')).toBeVisible();
        await expect(page.getByLabel('OIDC Audience')).toHaveValue(new URL(page.url()).origin);
        await expect(page.getByText(`${new URL(page.url()).origin}/login`)).toBeVisible();
        await expect(page.getByText('Callback URL', { exact: true })).toBeVisible();

        await page.getByPlaceholder('e.g. My GitHub').fill('Acme GitHub');
        await page.getByLabel('App ID').fill('12345');
        await page.getByLabel('Client ID').fill('Iv1.abc');
        await page.getByLabel('Client Secret').fill('s3cret');
        await page.getByLabel('Private Key').fill('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----');
        await page.getByRole('button', { name: 'Save' }).click();

        await expect.poll(() => requests.find(r => r.method === 'POST' && r.path === '/api/admin/vcs-integrations')).toBeTruthy();
        const body = requests.find(r => r.method === 'POST' && r.path === '/api/admin/vcs-integrations')!.body as {
            platform: string;
            name: string;
            config: Record<string, string>;
        };
        expect(body.platform).toBe('github');
        expect(body.name).toBe('Acme GitHub');
        expect(Object.keys(body.config).sort()).toEqual(['appId', 'clientId', 'clientSecret', 'oidcAudience', 'privateKey']);
        expect(body.config.oidcAudience).toBe(new URL(page.url()).origin);
    });

    test('editing a GitHub integration keeps secrets blank and sends platform', async ({ page }) => {
        const requests = await mockApi(page);
        await page.goto('/admin/vcs-integrations');

        const item = page.locator('.item', { hasText: GITHUB.name });
        await item.getByRole('button', { name: 'Edit' }).click();

        await expect(page.getByText('Key configured')).toBeVisible();
        await expect(page.getByLabel('Client Secret')).toHaveValue('');
        await page.getByRole('button', { name: 'Save' }).click();

        await expect.poll(() => requests.find(r => r.method === 'PUT')).toBeTruthy();
        const body = requests.find(r => r.method === 'PUT')!.body as { platform: string; config: Record<string, string> };
        expect(body.platform).toBe('github');
        expect(body.config.clientSecret).toBe('');
        expect(body.config.privateKey).toBe('');
        expect(body.config.oidcAudience).toBe(AUDIENCE);
    });

    test('add app for a GitHub integration shows the workflow snippet', async ({ page }) => {
        await mockApi(page);
        await page.goto('/apps');

        await page.getByRole('button', { name: 'Add App' }).click();
        // default integration comes from the session's vcsId
        await expect(page.locator('select').first()).toHaveValue(GITHUB.id);

        await page.getByPlaceholder(/paste a GitHub\/GitLab URL/).fill('mock');
        await page.getByText('acme/mock-repo').click();
        await page.getByRole('button', { name: 'Create App' }).click();

        await expect(page.getByText('.github/workflows/pixelci.yml')).toBeVisible();
        const snippet = page.locator('pre code');
        await expect(snippet).toContainText('docker://ghcr.io/zyno-io/pixelci/cli:latest');
        await expect(snippet).toContainText('id-token: write');
        await expect(snippet).toContainText(`PIXELCI_API_URL: ${AUDIENCE}`);
        await expect(snippet).toContainText('PIXELCI_APP_ID: app-mock-1');
    });

    test('login shows a button with an icon per provider', async ({ page }) => {
        await mockApi(page, { authenticated: false });
        await page.goto('/login');

        await expect(page.getByRole('button', { name: /Login via Mock GitLab/ })).toBeVisible();
        await expect(page.getByRole('button', { name: /Login via Mock GitHub/ })).toBeVisible();
        await expect(page.locator('button i.fa-github')).toHaveCount(1);
        await expect(page.locator('button i.fa-gitlab')).toHaveCount(1);
    });

    test('login error is shown without auto-redirecting', async ({ page }) => {
        await mockApi(page, { authenticated: false, providers: [GITHUB] });
        await page.goto('/login?error=access_denied&error_description=The+user+denied+access');

        await expect(page.getByRole('alert')).toContainText('The user denied access');
        await expect(page.getByRole('button', { name: /Login via Mock GitHub/ })).toBeVisible();
        expect(new URL(page.url()).pathname).toBe('/login');
    });
});
