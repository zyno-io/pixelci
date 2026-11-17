import { expect, Page, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const colorSchemes = ['light', 'dark'] as const;

// The review steps below persist approve/reject decisions on the shared seeded build. Reset that
// state before every test (and retry) so each run starts from the pristine, unreviewed state the
// clean-state screenshots and image-visibility waits depend on — otherwise the second color scheme
// would load already-reviewed screens, which render collapsed (image hidden) and fail the run.
const seedScript = fileURLToPath(new URL('../../../api/tests/scripts/seed-e2e.mjs', import.meta.url));
test.beforeEach(() => {
    execFileSync('node', [seedScript, '--reset-reviews'], { stdio: 'inherit' });
});

const JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhcHAiLCJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjI1MjQ2MDc5OTksImlhdCI6MTc0NzYzMjc2Mn0.7FmHrOWWRWmH8i8floyAE-VvYu4Lya_9c-Qy68r8puI';
// The seeded, approved feature build whose Homepage change is decision D1 (see seed-e2e.mjs).
const APPROVED_BUILD_URL = '/apps/00000000-0000-0000-0000-000000000001/builds/00000000-0000-0000-0000-000000000005';

colorSchemes.forEach(colorScheme => {
    test.describe(`${colorScheme} mode`, () => {
        test.use({ colorScheme });

        const takeScreenshot = (page: Page, name: string) => page.screenshot({ path: `screenshots/${name} (${colorScheme}).png` });

        // Captures the whole scrollable page by temporarily growing the viewport to its full height.
        const takeFullPageScreenshot = async (page: Page, name: string) => {
            const mainScrollHeight = await page.evaluate(() => document.querySelector('main')!.scrollHeight);
            const viewportSize = page.viewportSize()!;
            await page.setViewportSize({ width: viewportSize.width, height: mainScrollHeight });
            await takeScreenshot(page, name);
            await page.setViewportSize(viewportSize);
        };

        test('displays all the things', async ({ page }) => {
            // Pre-auth before the first navigation: with a single VCS provider the login screen now
            // auto-redirects to the (unreachable) OAuth host, so there's no picker to land on/screenshot.
            await page.addInitScript(() => {
                // jwt for zero ID valid until 2049
                window.localStorage.setItem(
                    'pixelci:jwt',
                    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhcHAiLCJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjI1MjQ2MDc5OTksImlhdCI6MTc0NzYzMjc2Mn0.7FmHrOWWRWmH8i8floyAE-VvYu4Lya_9c-Qy68r8puI'
                );
            });

            await page.goto('/');

            await expect(page.url()).toMatch(/\/apps$/);
            await takeScreenshot(page, 'App List');

            await page.locator('.app').first().click();
            await page.waitForSelector('.build');
            await page.locator('.build-date').evaluateAll(els => els.forEach(el => (el.textContent = '1/1/25 12:32 PM')));
            await takeScreenshot(page, 'Build List');

            // ── Screen gallery and lightbox ──
            await page.locator('[data-testid="browse-screens"]').click();
            await page.waitForSelector('[data-testid="gallery-tile"] img');
            // Every tile is on screen with the seeded app, so every thumbnail loads.
            await expect(page.locator('[data-testid="gallery-tile"] .tile-loading')).toHaveCount(0, { timeout: 10000 });
            await takeScreenshot(page, 'Screen Gallery');

            await page.locator('[data-testid="gallery-tile"]').first().click();
            await page.waitForSelector('[data-testid="lightbox-stage"] img');
            await takeScreenshot(page, 'Screen Lightbox');
            await page.locator('[data-testid="lightbox-close"]').click();

            // The seeded Homepage screen has one mask; the editor draws it over the screenshot, with its fields beside it.
            await page.locator('[data-testid="gallery-tile"]').filter({ hasText: 'Homepage' }).click();
            await page.waitForSelector('[data-testid="lightbox-stage"] [data-testid="mask-rect"]');
            await expect(page.locator('[data-testid="mask-row"]')).toHaveCount(1);
            await page.locator('[data-testid="masks-section"]').scrollIntoViewIfNeeded();
            await takeScreenshot(page, 'Screen Lightbox - Masks');
            await page.locator('[data-testid="lightbox-close"]').click();
            await page.goBack();
            await page.waitForSelector('.build');

            // Hold image and diff requests until their loading state has been captured. A fixed delay
            // raced the screenshots: diffs can be requested before diff mode is switched on, so on a
            // slow run the diff had already arrived when "Diff Mode - Loading" was taken.
            const gate = () => {
                let open!: () => void;
                const opened = new Promise<void>(resolve => (open = resolve));
                return { opened, open };
            };
            const imageGate = gate();
            const diffGate = gate();
            await page.route(/\/image$/, async route => {
                await imageGate.opened;
                await route.continue();
            });
            await page.route(/\/diff$/, async route => {
                await diffGate.opened;
                await route.continue();
            });

            await page.locator('.build').first().locator('span').first().click();
            await page.waitForSelector('.screen');
            await takeScreenshot(page, 'Screen List - Loading');
            imageGate.open();
            await page.waitForSelector('.image-wrapper.left img');
            await takeScreenshot(page, 'Screen List');

            await page.locator('input[data-testid="diff-check"]').check();
            await takeScreenshot(page, 'Screen List - Diff Mode - Loading');
            diffGate.open();
            await page.waitForSelector('.image-wrapper.right .diff img');
            await takeScreenshot(page, 'Screen List - Diff Mode');

            await page.locator('input[data-testid="diff-check"]').uncheck();
            await page.locator('[data-testid="filter-all"]').click();
            // Unchanged screens are collapsed one-line rows; wait for every screenshot to finish loading.
            await expect(page.locator('.screen .loading')).toHaveCount(0, { timeout: 10000 });
            await takeFullPageScreenshot(page, 'Screen List - All Screens');

            // ── Review states ──
            // Back to the Needs review filter so the per-screen review controls are available.
            await page.locator('[data-testid="filter-review"]').click();

            // Submits a review for the named screen. A previous (retried) run may have left the
            // screen already reviewed and collapsed, so expand it first to reach the review bar.
            const reviewScreen = async (name: string, action: 'approve' | 'reject', comment: string) => {
                const screen = page.locator('.screen').filter({ hasText: name });
                // Wait for the screen's review UI to render in whichever state it lands.
                await screen.locator('.review-bar, .collapsed-summary').first().waitFor();
                if (await screen.locator('.collapsed-summary').isVisible()) {
                    await screen.locator('.collapse-toggle').click();
                    await screen.locator('.review-bar').waitFor();
                }
                await screen.locator('.review-comment').fill(comment);
                await screen.locator(`.review-actions .${action}`).click();
                await screen.locator('.collapsed-summary').waitFor();
                return screen;
            };

            // Collapsed approved: a reviewed screen collapses to its summary row.
            await reviewScreen('Login', 'approve', 'Looks good!');
            // Let the collapse/expand transition settle before capturing.
            await page.waitForTimeout(600);
            await takeFullPageScreenshot(page, 'Screen List - Approved Collapsed');

            // Expanded rejected: reject, then re-expand to show the active reject state + comment.
            const rejected = await reviewScreen('Homepage', 'reject', 'Needs changes.');
            await rejected.locator('.collapse-toggle').click();
            await rejected.locator('.review-bar').waitFor();
            await page.waitForTimeout(600);
            await takeFullPageScreenshot(page, 'Screen List - Rejected Expanded');
        });

        // Build 005 made the Homepage change, so it shows who approved it and lets a reviewer take that back.
        test('shows who approved a change and revokes it', async ({ page }) => {
            await page.addInitScript(jwt => window.localStorage.setItem('pixelci:jwt', jwt), JWT);
            await page.goto(APPROVED_BUILD_URL);
            await page.waitForSelector('.screen');
            await page.locator('[data-testid="filter-all"]').click();
            await expect(page.locator('.screen .loading')).toHaveCount(0, { timeout: 10000 });

            const homepage = page.locator('.screen').filter({ hasText: 'Homepage' });
            await expect(homepage.getByTestId('provenance')).toContainText('Approved by E2E Test User');
            await takeScreenshot(page, 'Screen List - Approved Build');

            await homepage.getByTestId('revoke-approval').click();
            await takeScreenshot(page, 'Screen List - Revoke Confirm');
            await page.locator('[data-testid="submit-confirm"]').click();

            await expect(homepage.getByTestId('provenance')).toContainText('Approval revoked by E2E Test User');
            await expect(homepage.getByTestId('revoke-approval')).toHaveCount(0);

            // The revoke is stored: a fresh load still shows it.
            await page.reload();
            await page.waitForSelector('.screen');
            await page.locator('[data-testid="filter-all"]').click();
            await expect(page.locator('.screen').filter({ hasText: 'Homepage' }).getByTestId('provenance')).toContainText(
                'Approval revoked by E2E Test User'
            );
        });
    });
});
