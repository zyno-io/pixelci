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

test.describe('Screen gallery', () => {
    test('the app gallery lists baseline screens, filters by name and opens a lightbox', async ({ page }) => {
        await mockApi(page);
        await page.goto(`/apps/${appId}`);
        await page.getByTestId('browse-screens').click();
        await expect(page).toHaveURL(new RegExp(`/apps/${appId}/screens$`));

        const tiles = page.getByTestId('gallery-tile');
        await expect(tiles).toHaveCount(8);
        await expect(tiles.first().locator('img')).toBeVisible();
        // A screen uploaded since the baseline says so.
        await expect(tiles.filter({ hasText: 'Empty state' })).toContainText('Not in baseline');

        await page.getByTestId('gallery-search').fill('log');
        await expect(tiles).toHaveCount(2);
        await expect(page.locator('.result-count')).toHaveText('2 of 8 screens');

        await tiles.first().click();
        const lightbox = page.getByTestId('lightbox');
        await expect(lightbox.getByRole('heading', { name: 'Login' })).toBeVisible();
        await expect(lightbox.locator('.lb-count')).toHaveText('1 of 2');
        await expect(lightbox.getByTestId('lightbox-stage').locator('img')).toBeVisible();

        // The arrow keys step through the filtered list; Escape closes and returns focus to the tile.
        await page.keyboard.press('ArrowRight');
        await expect(lightbox.getByRole('heading', { name: 'Audit log' })).toBeVisible();
        await expect(lightbox.getByTestId('lightbox-next')).toBeDisabled();
        await page.keyboard.press('Escape');
        await expect(lightbox).toHaveCount(0);
        await expect(tiles.first()).toBeFocused();
    });

    test('a screen tolerance can be previewed against the build and saved', async ({ page }) => {
        await mockApi(page);
        await page.goto(`/apps/${appId}/builds/${buildId}`);
        await page.getByTestId('open-gallery').click();
        await expect(page).toHaveURL(new RegExp(`/builds/${buildId}/screens$`));

        await page.getByTestId('gallery-filter-changed').click();
        await page.getByTestId('gallery-tile').filter({ hasText: 'Dashboard' }).click();

        const lightbox = page.getByTestId('lightbox');
        const preview = lightbox.getByTestId('tolerance-preview');
        // The app default (0.01%) is below the measured 0.5%.
        await expect(preview).toContainText('Would be flagged');
        await expect(lightbox.getByTestId('tolerance-save')).toBeDisabled();

        const allowed = lightbox.getByTestId('tolerance-diffPctTolerance');
        await expect(allowed).toHaveAttribute('placeholder', '0.01');
        await allowed.fill('1');
        await expect(preview).toContainText('Would pass');

        // The diff view shows the diff those values produce.
        await lightbox.getByTestId('preview-show-diff').click();
        await expect(lightbox.getByTestId('lightbox-stage').locator('img')).toHaveAttribute('src', /^data:image/);

        await allowed.fill('250');
        await expect(lightbox.locator('.tolerance-state.error')).toHaveText('Enter 0 to 100');
        await expect(lightbox.getByTestId('tolerance-save')).toBeDisabled();

        // An invalid value takes the verdict down rather than leaving a stale one up.
        await expect(preview).toContainText('Correct the highlighted value');

        // Reset returns the field to inheriting; nothing is left to save.
        await allowed.fill('1');
        await expect(lightbox.locator('.lb-unsaved')).toBeVisible();
        await lightbox.getByTestId('tolerance-reset-diffPctTolerance').click();
        await expect(allowed).toHaveValue('');
        await expect(lightbox.locator('.lb-unsaved')).toHaveCount(0);

        await allowed.fill('1');
        await expect(preview).toContainText('Would pass');
        await lightbox.getByTestId('tolerance-save').click();
        await expect(lightbox.getByTestId('tolerance-save')).toBeDisabled();
        await expect(lightbox.locator('.lb-section-head .tag')).toHaveText('Custom');
        await page.getByTestId('lightbox-close').click();
        await expect(page.getByTestId('gallery-tile').filter({ hasText: 'Dashboard' })).toContainText('Custom');
    });

    test('the review screen opens a tolerance view for a screen', async ({ page }) => {
        await mockApi(page);
        await page.goto(`/apps/${appId}/builds/${buildId}`);
        const screen = page.locator('.screen').filter({ hasText: 'Dashboard' });
        await screen.getByTestId('open-tolerance').click();

        const lightbox = page.getByTestId('lightbox');
        await expect(lightbox.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
        await expect(lightbox.getByTestId('tolerance-preview')).toContainText('0.500% of pixels differ');

        // Review shortcuts stay off while the lightbox is open.
        await page.keyboard.press('a');
        await expect(screen.locator('.review-badge')).toHaveCount(0);

        await lightbox.getByTestId('tolerance-shiftTolerance').fill('3');
        await lightbox.getByTestId('tolerance-save').click();
        await page.keyboard.press('Escape');
        await expect(screen.getByTestId('open-tolerance')).toContainText('Custom tolerance');
    });

    test('app tolerances are editable by admins and read-only for everyone else', async ({ page }) => {
        await mockApi(page);
        await page.goto(`/apps/${appId}/screens`);
        await page.getByTestId('app-tolerances').click();
        const dialog = page.getByTestId('app-tolerances-dialog');
        await expect(dialog.getByRole('heading', { name: 'Tolerances for PixelCI UI' })).toBeVisible();
        await dialog.getByTestId('tolerance-colorTolerance').fill('0.3');
        await dialog.getByTestId('app-tolerances-save').click();
        await expect(dialog).toHaveCount(0);

        // Screens without their own value now inherit the app's.
        await page.getByTestId('gallery-tile').first().click();
        await expect(page.getByTestId('lightbox').getByTestId('tolerance-colorTolerance')).toHaveAttribute('placeholder', '0.3');
        await page.keyboard.press('Escape');

        await page.unroute('**/api/**');
        await mockApi(page, { admin: false });
        await page.reload();
        await page.getByTestId('app-tolerances').click();
        await expect(dialog.getByTestId('tolerance-colorTolerance')).toBeDisabled();
        await expect(dialog.getByTestId('app-tolerances-save')).toHaveCount(0);
        await expect(dialog).toContainText("Only administrators can change an app's tolerances.");
    });

    test('the gallery and lightbox fit a phone viewport', async ({ page }) => {
        await mockApi(page);
        await page.setViewportSize({ width: 360, height: 800 });
        await page.goto(`/apps/${appId}/screens`);
        await expect(page.getByTestId('gallery-tile')).toHaveCount(8);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

        await page.getByTestId('gallery-tile').first().click();
        const bounds = await page.locator('.vf-modal').boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
        await expect(page.getByTestId('tolerance-save')).toBeVisible();
    });
});
