import { expect, test, type Page } from '@playwright/test';

import { appId, buildId, createDesignApi } from './fixtures/design-system';

async function mockApi(page: Page, options: Parameters<typeof createDesignApi>[0] = {}) {
    const respond = createDesignApi(options);
    await page.route('**/api/**', async route => {
        const request = route.request();
        const response = respond(new URL(request.url()).pathname, request.method(), request.postDataJSON() ?? undefined);
        await route.fulfill(response);
    });
}

test('theme menu supports keyboard selection, persistence and system preference', async ({ page }) => {
    await mockApi(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/apps');
    const trigger = page.getByRole('button', { name: 'Theme', exact: true });
    await trigger.press('ArrowDown');
    await expect(page.getByRole('menuitemradio', { name: 'System' })).toBeFocused();
    await page.getByRole('menu').press('End');
    await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toBeFocused();
    await page.getByRole('menuitemradio', { name: 'Dark' }).press('Enter');
    await expect(page.locator('html')).toHaveClass('dark');
    await expect(trigger).toBeFocused();
    await page.reload();
    await expect(page.locator('html')).toHaveClass('dark');
    await trigger.click();
    await page.getByRole('menuitemradio', { name: 'System' }).click();
    await expect(page.locator('html')).not.toHaveClass('dark');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass('dark');
});

test('admin menu supports keyboard navigation and restores focus on Escape', async ({ page }) => {
    await mockApi(page);
    await page.goto('/apps');
    const trigger = page.getByRole('button', { name: 'Administration' });
    await trigger.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'VCS Integrations' })).toBeFocused();
    await page.getByRole('menu').press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Users', exact: true })).toBeFocused();
    await page.getByRole('menu').press('Escape');
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await page.getByRole('menuitem', { name: 'Users', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);
});

test('administration stays hidden for non-admin users', async ({ page }) => {
    await mockApi(page, { admin: false });
    await page.goto('/apps');
    await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Administration' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add App' })).toHaveCount(0);
});

for (const colorScheme of ['light', 'dark'] as const) {
    test(`build status labels remain readable in ${colorScheme} mode`, async ({ page }) => {
        await mockApi(page);
        await page.emulateMedia({ colorScheme });
        await page.goto(`/apps/${appId}`);
        await expect(page.locator('.build')).toHaveCount(6);
        const ratios = await page.locator('.status').evaluateAll(elements => {
            const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number);
            const luminance = (color: number[]) =>
                color.slice(0, 3).reduce((sum, channel, i) => {
                    const n = channel / 255;
                    return sum + (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
                }, 0);
            return elements.map(element => {
                let background = [255, 255, 255];
                const ancestors: Element[] = [];
                for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
                for (const node of ancestors) {
                    const color = rgb(getComputedStyle(node).backgroundColor);
                    const alpha = color[3] ?? 1;
                    background = background.map((channel, i) => color[i] * alpha + channel * (1 - alpha));
                }
                const foreground = luminance(rgb(getComputedStyle(element).color));
                const backdrop = luminance(background);
                return (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05);
            });
        });
        for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    test(`comparison controls and review states work in ${colorScheme} mode`, async ({ page }) => {
        await mockApi(page);
        await page.emulateMedia({ colorScheme });
        await page.goto(`/apps/${appId}/builds/${buildId}`);
        const screen = page.locator('.screen').filter({ hasText: 'Dashboard' });
        await expect(screen.locator('.image-wrapper.left img')).toBeVisible();
        await expect(screen.locator('.image-wrapper.right img')).toBeVisible();
        await page.getByTestId('diff-check').check();
        await expect(screen.locator('.diff img')).toBeVisible();
        await page.getByTestId('zoom-select').selectOption('50');
        const widths = await screen.locator('.image-wrapper img').evaluateAll(images => images.map(image => image.getBoundingClientRect().width));
        expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
        await screen.getByPlaceholder('Leave a comment (optional)').fill('Looks good');
        await screen.getByRole('button', { name: 'Approve', exact: true }).click();
        await expect(screen.locator('.review-badge')).toHaveText('Approved');
        await expect(screen.locator('.collapsed-summary')).toContainText('Looks good');
        await screen.locator('.collapse-toggle').click();
        await screen.getByRole('button', { name: 'Reject', exact: true }).click();
        await expect(screen.locator('.review-badge')).toHaveText('Rejected');
    });
}

test('mobile pages and app dialogs fit the viewport', async ({ page }) => {
    await mockApi(page);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/apps');
    await page.getByRole('button', { name: 'Add App' }).click();
    await expect(page.getByRole('heading', { name: 'Add App' })).toBeVisible();
    const modalBounds = await page.locator('.vf-modal').boundingBox();
    expect(modalBounds!.x).toBeGreaterThanOrEqual(0);
    expect(modalBounds!.x + modalBounds!.width).toBeLessThanOrEqual(360);
    await page.getByRole('button', { name: 'Cancel' }).click();
    for (const path of [`/apps/${appId}`, `/apps/${appId}/builds/${buildId}`, '/admin/users', '/admin/vcs-integrations']) {
        await page.goto(path);
        await expect(page.locator('.header h1')).toBeVisible();
        const width = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(width).toBeLessThanOrEqual(360);
    }
});

test('login and onboarding have working theme controls on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await mockApi(page, { anonymous: true });
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Login via GitLab', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass('dark');
    await page.unroute('**/api/**');
    await mockApi(page, { onboarding: true });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome to PixelCI' })).toBeVisible();
    await expect(page.getByLabel('Integration Name')).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(360);
});
