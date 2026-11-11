import { expect, test } from '@playwright/test';

test.describe('Screen Comparisons', () => {
    test.beforeEach(async ({ page }) => {
        // Pre-auth before the first navigation so the single-provider login doesn't auto-redirect to OAuth.
        await page.addInitScript(() => {
            window.localStorage.setItem(
                'pixelci:jwt',
                'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhcHAiLCJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjI1MjQ2MDc5OTksImlhdCI6MTc0NzYzMjc2Mn0.7FmHrOWWRWmH8i8floyAE-VvYu4Lya_9c-Qy68r8puI'
            );
        });

        // Other specs (basic.spec.ts) write real review decisions to the shared seed, possibly in parallel.
        // Serve the screen list with review fields cleared so these tests always start unreviewed.
        await page.route(/\/builds\/[^/]+\/screens$/, async route => {
            const response = await route.fetch();
            const screens = await response.json();
            for (const screen of screens) {
                if (screen.currentBuildScreen) {
                    screen.currentBuildScreen.reviewStatus = null;
                    screen.currentBuildScreen.reviewComment = null;
                    screen.currentBuildScreen.reviewedById = null;
                    screen.currentBuildScreen.reviewedAt = null;
                }
            }
            await route.fulfill({ response, json: screens });
        });

        // Review and build-approve writes are stubbed so these tests never touch the shared seed data.
        await page.route(/\/screens\/[^/]+\/review$/, async route => {
            const body = route.request().postDataJSON();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    reviewStatus: body.reviewStatus,
                    reviewComment: body.comment ?? '',
                    reviewedById: '00000000-0000-0000-0000-000000000000',
                    reviewedAt: new Date().toISOString()
                })
            });
        });
        await page.route(/\/builds\/[^/]+\/approve$/, route => route.abort());

        await page.goto('/');

        // Navigate to a build with screens
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');
        await page.locator('.build').first().locator('span').first().click();
        await page.waitForSelector('.screen');
    });

    test('can toggle between original and diff view', async ({ page }) => {
        const diffCheckbox = page.locator('input[data-testid="diff-check"]');

        // Initially unchecked
        await expect(diffCheckbox).not.toBeChecked();

        // Check the diff view
        await diffCheckbox.check();
        await expect(diffCheckbox).toBeChecked();

        // Uncheck back to original
        await diffCheckbox.uncheck();
        await expect(diffCheckbox).not.toBeChecked();
    });

    test('can filter to show only changes', async ({ page }) => {
        const reviewButton = page.locator('[data-testid="filter-review"]');
        const allButton = page.locator('[data-testid="filter-all"]');

        // Default is Needs review when anything needs review
        await expect(reviewButton).toHaveAttribute('aria-pressed', 'true');
        await expect(allButton).toHaveAttribute('aria-pressed', 'false');
        const changesOnlyCount = await page.locator('.screen').count();

        // Switch to all screens
        await allButton.click();
        await expect(allButton).toHaveAttribute('aria-pressed', 'true');
        await expect(reviewButton).toHaveAttribute('aria-pressed', 'false');
        const allScreensCount = await page.locator('.screen').count();

        // Changes-only count should be less than all screens (the seeded build has unchanged screens)
        expect(changesOnlyCount).toBeLessThan(allScreensCount);

        // And back
        await reviewButton.click();
        await expect(page.locator('.screen')).toHaveCount(changesOnlyCount);
    });

    test('all screens view collapses unchanged screens until expanded', async ({ page }) => {
        await page.locator('[data-testid="filter-all"]').click();
        const unchanged = page.locator('.screen').filter({ hasText: 'No Changes' }).first();
        await expect(unchanged.locator('.image-wrapper img')).toBeHidden();

        await unchanged.locator('.collapse-toggle').click();
        await expect(unchanged.locator('.image-wrapper img')).toBeVisible();
        // Unchanged screens show a single screenshot, not a comparison.
        await expect(unchanged.locator('.image-wrapper img')).toHaveCount(1);
    });

    for (const [value, scale] of [
        ['100', 1],
        ['50', 0.5],
        ['25', 0.25]
    ] as const) {
        test(`${value}% zoom renders the new build at ${value}% of its natural width`, async ({ page }) => {
            await page.getByTestId('zoom-select').selectOption(value);
            await expect(page.getByTestId('zoom-select')).toHaveValue(value);

            const img = page.locator('.screen').first().locator('.image-wrapper.right img').first();
            await expect(img).toBeVisible();
            await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

            const { rendered, natural } = await img.evaluate((el: HTMLImageElement) => ({
                rendered: el.getBoundingClientRect().width,
                natural: el.naturalWidth
            }));
            expect(Math.abs(rendered - natural * scale)).toBeLessThanOrEqual(1);
        });
    }

    test('fit height shows the whole screenshot inside the pane without vertical scrolling', async ({ page }) => {
        await page.getByTestId('zoom-select').selectOption('fit-height');
        const screen = page.locator('.screen').first();
        const left = screen.locator('.image-wrapper.left');
        const right = screen.locator('.image-wrapper.right');
        const leftImg = left.locator('img').first();
        const rightImg = right.locator('img').first();
        await expect(leftImg).toBeVisible();
        await expect(rightImg).toBeVisible();
        await expect.poll(() => rightImg.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
        await expect.poll(() => leftImg.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

        const measure = (pane: typeof left, img: typeof leftImg) =>
            Promise.all([pane.evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight })), img.boundingBox()]);
        const [leftPane, leftBox] = await measure(left, leftImg);
        const [rightPane, rightBox] = await measure(right, rightImg);

        expect(rightBox!.height).toBeLessThanOrEqual(rightPane.client + 1);
        expect(leftBox!.height).toBeLessThanOrEqual(leftPane.client + 1);
        expect(rightPane.scroll).toBeLessThanOrEqual(rightPane.client + 1);
        expect(leftPane.scroll).toBeLessThanOrEqual(leftPane.client + 1);
        expect(Math.abs(leftBox!.width - rightBox!.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(leftBox!.height - rightBox!.height)).toBeLessThanOrEqual(1);
    });

    test('zoom selection persists across a reload', async ({ page }) => {
        const select = page.getByTestId('zoom-select');
        await expect(select).toHaveValue('fit-width');
        await select.selectOption('50');
        await page.reload();
        await expect(page.getByTestId('zoom-select')).toHaveValue('50');
    });

    test('decision bar tracks review progress', async ({ page }) => {
        const progress = page.locator('[data-testid="decision-bar"] .progress');
        await expect(progress).toContainText('0 of 2 reviewed');

        const screen = page.locator('.screen').filter({ hasText: 'Login' });
        await screen.locator('.review-actions .approve').click();
        await expect(screen.locator('.collapsed-summary')).toBeVisible();
        await expect(progress).toContainText('1 of 2 reviewed');
    });

    test('keyboard shortcuts: A approves the active screen and J moves to the next', async ({ page }) => {
        const screens = page.locator('.screen');
        await expect(screens).toHaveCount(2);

        // J from nothing activates the first screen; A approves it (review is stubbed)
        await page.keyboard.press('j');
        await expect(screens.nth(0)).toHaveClass(/is-active/);
        await page.keyboard.press('a');
        await expect(screens.nth(0).locator('.collapsed-summary')).toBeVisible();
        await expect(page.locator('[data-testid="decision-bar"] .progress')).toContainText('1 of 2 reviewed');

        // Approving advances to the next screen; K goes back, J forward again
        await expect(screens.nth(1)).toHaveClass(/is-active/);
        await page.keyboard.press('k');
        await expect(screens.nth(0)).toHaveClass(/is-active/);
        await page.keyboard.press('j');
        await expect(screens.nth(1)).toHaveClass(/is-active/);
    });

    test('R rejects the active screen and the button becomes Submit review', async ({ page }) => {
        const submit = page.locator('[data-testid="submit-build"]');
        await expect(submit).toHaveText('Approve build');

        await page.keyboard.press('j');
        await page.keyboard.press('r');
        await expect(page.locator('.screen').nth(0).locator('.review-badge')).toHaveText('Rejected');
        await expect(submit).toHaveText('Submit review');
    });

    test('holding D flashes the diff', async ({ page }) => {
        const diff = page.locator('.screen .diff img').first();
        await expect(diff).toHaveCount(0);

        await page.keyboard.down('d');
        await expect(diff).toBeVisible();
        await page.keyboard.up('d');
        await expect(diff).toHaveCount(0);
    });

    test('shortcuts do nothing while typing in the comment field', async ({ page }) => {
        const screens = page.locator('.screen');
        const comment = screens.nth(0).locator('.review-comment');
        await comment.click();
        await page.keyboard.type('ajrd');

        await expect(comment).toHaveValue('ajrd');
        await expect(screens.nth(0).locator('.review-badge')).toHaveCount(0);
        await expect(screens.nth(0).locator('.collapsed-summary')).toHaveCount(0);
        await expect(screens.nth(1)).not.toHaveClass(/is-active/);
        await expect(page.locator('[data-testid="decision-bar"] .progress')).toContainText('0 of 2 reviewed');
        await expect(page.locator('.screen .diff img')).toHaveCount(0);
    });

    test('submit opens a confirmation dialog that starts on Cancel and closes with Escape', async ({ page }) => {
        await page.locator('.decision-bar [data-testid="submit-build"]').click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(page.locator('[data-testid="submit-confirm"]')).toHaveText('Approve build');
        await expect(page.locator('[data-testid="submit-cancel"]')).toBeFocused();

        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(page.locator('[data-testid="submit-build"]')).toBeVisible();

        // The Cancel button closes it too
        await page.locator('[data-testid="submit-build"]').click();
        await expect(dialog).toBeVisible();
        await page.locator('[data-testid="submit-cancel"]').click();
        await expect(dialog).toBeHidden();
    });

    test('screens removed from the build show under Needs review without counting as reviewable', async ({ page }) => {
        await page.route(/\/builds\/[^/]+\/screens$/, async route => {
            const response = await route.fetch();
            const screens = await response.json();
            for (const screen of screens) {
                if (screen.currentBuildScreen) {
                    screen.currentBuildScreen.reviewStatus = null;
                    screen.currentBuildScreen.reviewComment = null;
                    screen.currentBuildScreen.reviewedById = null;
                    screen.currentBuildScreen.reviewedAt = null;
                }
            }
            const { currentBuildScreen: _current, referenceBuildScreen: _reference, ...template } = screens[0];
            screens.push({ ...template, screenId: '00000000-0000-0000-0000-0000000000ff', name: 'Removed page' });
            await route.fulfill({ response, json: screens });
        });
        await page.reload();
        await page.waitForSelector('.screen');

        await expect(page.locator('[data-testid="filter-review"]')).toHaveAttribute('aria-pressed', 'true');
        const removed = page.locator('.screen').filter({ hasText: 'Removed page' });
        await expect(removed).toBeVisible();
        await expect(removed.locator('.screen-status')).toHaveText('Removed');
        await expect(removed).toContainText('This screen is no longer in the build.');
        await expect(page.locator('.screen')).toHaveCount(3);
        await expect(page.locator('[data-testid="filter-review"]')).toContainText('Needs review (3)');

        const progress = page.locator('[data-testid="decision-bar"] .progress');
        await expect(progress).toContainText('0 of 2 reviewed');
        await expect(progress).toContainText('1 removed');
    });

    test('focusing the Diff checkbox does not swallow the shortcuts', async ({ page }) => {
        const screens = page.locator('.screen');
        await page.locator('input[data-testid="diff-check"]').check();

        await page.keyboard.press('j');
        await expect(screens.nth(0)).toHaveClass(/is-active/);
        await page.keyboard.press('j');
        await expect(screens.nth(1)).toHaveClass(/is-active/);
        // J scrolls the card into view smoothly; A only reviews a card that is on screen.
        await expect(screens.nth(1)).toBeInViewport();
        let lastY = Number.NaN;
        await expect
            .poll(
                async () => {
                    const y = (await screens.nth(1).boundingBox())!.y;
                    const stable = y === lastY;
                    lastY = y;
                    return stable;
                },
                { intervals: [200] }
            )
            .toBe(true);
        await page.keyboard.press('a');
        await expect(screens.nth(1).locator('.review-badge')).toHaveText('Approved');
    });

    test('a build that is not awaiting review is read-only', async ({ page }) => {
        await page.route(/\/builds\/[^/]+$/, async route => {
            if (!['fetch', 'xhr'].includes(route.request().resourceType())) return route.fallback();
            const response = await route.fetch();
            const build = await response.json();
            build.status = 'changes approved';
            await route.fulfill({ response, json: build });
        });
        await page.reload();
        await page.waitForSelector('.screen');

        await expect(page.locator('[data-testid="decision-bar"]')).toHaveCount(0);
        await expect(page.locator('.review-bar')).toHaveCount(0);
        // Shortcuts are inert too
        await page.keyboard.press('j');
        await page.keyboard.press('a');
        await expect(page.locator('.review-badge')).toHaveCount(0);
    });

    test('holding A (key auto-repeat) does not review further screens', async ({ page }) => {
        const screens = page.locator('.screen');
        await page.keyboard.press('j');
        await page.keyboard.press('a');
        await expect(screens.nth(0).locator('.collapsed-summary')).toBeVisible();
        await expect(screens.nth(1)).toHaveClass(/is-active/);

        await page.evaluate(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', repeat: true, bubbles: true }));
        });
        await page.waitForTimeout(500);
        await expect(screens.nth(1).locator('.collapsed-summary')).toHaveCount(0);
        await expect(screens.nth(1).locator('.review-badge')).toHaveCount(0);
        await expect(page.locator('[data-testid="decision-bar"] .progress')).toContainText('1 of 2 reviewed');
    });

    test('a read-only build with a removed screen opens on All screens', async ({ page }) => {
        await page.route(/\/builds\/[^/]+$/, async route => {
            if (!['fetch', 'xhr'].includes(route.request().resourceType())) return route.fallback();
            const response = await route.fetch();
            const build = await response.json();
            build.status = 'changes approved';
            await route.fulfill({ response, json: build });
        });
        await page.route(/\/builds\/[^/]+\/screens$/, async route => {
            const response = await route.fetch();
            const screens = await response.json();
            for (const screen of screens) {
                if (screen.currentBuildScreen) screen.currentBuildScreen.status = 'no changes';
            }
            const { currentBuildScreen: _current, referenceBuildScreen: _reference, ...template } = screens[0];
            screens.push({ ...template, screenId: '00000000-0000-0000-0000-0000000000ff', name: 'Removed page' });
            await route.fulfill({ response, json: screens });
        });
        await page.reload();
        await page.waitForSelector('.screen');

        await expect(page.locator('[data-testid="filter-all"]')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('[data-testid="filter-review"]')).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('.screen').filter({ hasText: 'Removed page' })).toBeVisible();
        // The seeded build's four screens plus the removed one.
        await expect(page.locator('.screen')).toHaveCount(5);
    });

    const BUILD_BRANCH_ID = '22222222-2222-2222-2222-222222222222';
    for (const onDefaultBranch of [true, false]) {
        test(`the approve confirm ${onDefaultBranch ? 'mentions' : 'omits'} removed screens on a ${onDefaultBranch ? 'default' : 'non-default'} branch`, async ({
            page
        }) => {
            await page.route(/\/apps\/[^/]+$/, async route => {
                if (!['fetch', 'xhr'].includes(route.request().resourceType())) return route.fallback();
                const response = await route.fetch();
                const app = await response.json();
                app.defaultBranchId = onDefaultBranch ? BUILD_BRANCH_ID : '11111111-1111-1111-1111-111111111111';
                await route.fulfill({ response, json: app });
            });
            await page.route(/\/builds\/[^/]+$/, async route => {
                if (!['fetch', 'xhr'].includes(route.request().resourceType())) return route.fallback();
                const response = await route.fetch();
                const build = await response.json();
                build.branchId = BUILD_BRANCH_ID;
                await route.fulfill({ response, json: build });
            });
            await page.route(/\/builds\/[^/]+\/screens$/, async route => {
                const response = await route.fetch();
                const screens = await response.json();
                for (const screen of screens) {
                    if (screen.currentBuildScreen) screen.currentBuildScreen.reviewStatus = null;
                }
                const { currentBuildScreen: _current, referenceBuildScreen: _reference, ...template } = screens[0];
                screens.push({ ...template, screenId: '00000000-0000-0000-0000-0000000000ff', name: 'Removed page' });
                await route.fulfill({ response, json: screens });
            });
            await page.reload();
            await page.waitForSelector('.screen');

            await page.locator('.decision-bar [data-testid="submit-build"]').click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();
            if (onDefaultBranch) await expect(dialog).toContainText('1 screen removed from this build will leave the baseline.');
            else await expect(dialog).not.toContainText('will leave the baseline');
            await page.locator('[data-testid="submit-cancel"]').click();
            await expect(dialog).toBeHidden();
        });
    }
});
