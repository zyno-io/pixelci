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

const buildUrl = `/apps/${appId}/builds/${buildId}`;
const cards = (page: Page) => page.locator('#screens .screen');
const active = (page: Page) => page.locator('#screens .screen.is-active');

async function openBuild(page: Page) {
    await mockApi(page, { screenCount: 300 });
    // Instant scrolling, so positions are settled as soon as a key press returns.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(buildUrl);
    await expect(cards(page).first()).toBeVisible();
}

test.describe('Virtual scrolling', () => {
    test('renders a bounded number of cards, and J/K reach far cards', async ({ page }) => {
        await openBuild(page);
        expect(await cards(page).count()).toBeLessThanOrEqual(12);

        for (let i = 0; i < 40; i++) await page.keyboard.press('j');
        await expect(active(page).locator('.screen-number')).toHaveText('40');
        await expect(active(page)).toBeFocused();

        const headerBottom = await page.locator('#screens .header').evaluate(el => el.getBoundingClientRect().bottom);
        const top = await active(page).evaluate(el => el.getBoundingClientRect().top);
        expect(top).toBeGreaterThanOrEqual(headerBottom - 1);
        expect(top).toBeLessThanOrEqual(headerBottom + 40);
        expect(await cards(page).count()).toBeLessThanOrEqual(12);

        await page.keyboard.press('k');
        await expect(active(page).locator('.screen-number')).toHaveText('39');
    });

    test('approving jumps to the next undecided card even when it is far away', async ({ page }) => {
        await openBuild(page);
        await page.getByTestId('filter-all').click();
        await page.keyboard.press('j');
        const review = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/screen-000/review'));
        await page.keyboard.press('a');
        await review;

        // Screens 2-60 are unchanged; the next one needing review is the 61st.
        await expect(active(page).locator('.screen-number')).toHaveText('61');
        await expect(active(page)).toBeFocused();
        await expect(active(page)).toBeInViewport();
    });

    test('switching filters keeps the card being read in place', async ({ page }) => {
        await openBuild(page);
        for (let i = 0; i < 10; i++) await page.keyboard.press('j');
        const name = await active(page).locator('.screen-name').textContent();
        const before = await active(page).evaluate(el => el.getBoundingClientRect().top);

        // "All screens" adds dozens of unchanged cards above it.
        await page.getByTestId('filter-all').click();
        const card = cards(page).filter({ has: page.locator('.screen-name', { hasText: name! }) });
        await expect(card).toBeInViewport();
        const after = await card.evaluate(el => el.getBoundingClientRect().top);
        expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
    });

    test('the active card stays rendered, with its focus and draft, when scrolled far away', async ({ page }) => {
        await openBuild(page);
        await page.keyboard.press('j');
        const comment = active(page).locator('textarea');
        await comment.fill('half-typed thought');
        await expect(comment).toBeFocused();

        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(5000);

        await expect(comment).toBeFocused();
        await expect(comment).toHaveValue('half-typed thought');
        expect(await cards(page).count()).toBeLessThanOrEqual(14);
    });

    test('images finishing late do not move the card being read', async ({ page }) => {
        await openBuild(page);
        let open!: () => void;
        const gate = new Promise<void>(resolve => (open = resolve));
        await page.route(/\/(image|diff)$/, async route => {
            await gate;
            await route.fallback();
        });
        await page.reload();
        await expect(cards(page).first()).toBeVisible();

        for (let i = 0; i < 10; i++) await page.keyboard.press('j');
        await expect(active(page).locator('.screen-number')).toHaveText('10');
        const before = (await active(page).boundingBox())!.y;

        open();
        await expect(page.locator('#screens .screen .loading')).toHaveCount(0);
        const after = (await active(page).boundingBox())!.y;
        expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
    });

    test('only images near the viewport are requested', async ({ page }) => {
        let requests = 0;
        page.on('request', req => {
            if (/\/(image|diff)$/.test(new URL(req.url()).pathname)) requests++;
        });
        await openBuild(page);
        await expect(page.locator('#screens .screen .loading')).toHaveCount(0);
        expect(requests).toBeLessThan(50);
    });

    test('full-size images past the memory budget are unloaded, and fetched again when their card comes back', async ({ page }) => {
        await openBuild(page);
        // 8 MB per image: a few screens of cards go past the 200 MB budget.
        const body = Buffer.alloc(8 * 1024 * 1024);
        await page.route(/\/(image|diff)$/, route => route.fulfill({ status: 200, contentType: 'image/png', body }));
        let firstImageRequests = 0;
        page.on('request', req => {
            if (new URL(req.url()).pathname.endsWith('/screen-000/image')) firstImageRequests++;
        });
        await page.reload();
        await expect(cards(page).first()).toBeVisible();
        await expect.poll(() => firstImageRequests).toBeGreaterThan(0);
        const loadedOnce = firstImageRequests;

        // Each stop renders a fresh set of cards and waits for their images, so earlier ones fall out of use.
        for (let stop = 0; stop < 4; stop++) {
            for (let i = 0; i < 8; i++) await page.keyboard.press('j');
            await expect(page.locator('#screens .screen .loading')).toHaveCount(0);
        }

        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(() => firstImageRequests).toBeGreaterThan(loadedOnce);
        await expect(page.locator('#screens .screen .loading')).toHaveCount(0);
    });

    test('the gallery renders only the rows near the viewport', async ({ page }) => {
        await mockApi(page, { screenCount: 300 });
        await page.goto(`/apps/${appId}/screens`);
        const tiles = page.getByTestId('gallery-tile');
        await expect(tiles.first()).toBeVisible();
        expect(await tiles.count()).toBeLessThanOrEqual(60);

        const first = page.getByRole('listitem').first();
        await expect(first).toHaveAttribute('aria-setsize', '300');
        await expect(first).toHaveAttribute('aria-posinset', '1');

        // Screen 290 to 299.
        await page.getByTestId('gallery-search').fill('Screen 29');
        await expect(page.locator('.result-count')).toHaveText('10 of 300 screens');
        await expect(tiles).toHaveCount(10);

        await page.getByTestId('gallery-search').fill('');
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const last = tiles.filter({ hasText: 'Screen 300' });
        await expect(last).toBeVisible();
        await expect(page.getByRole('listitem').filter({ has: last })).toHaveAttribute('aria-posinset', '300');
        expect(await tiles.count()).toBeLessThanOrEqual(60);
    });
});
