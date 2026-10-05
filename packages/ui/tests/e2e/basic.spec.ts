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

            await page.route(/\/image$/, async route => {
                await new Promise(resolve => setTimeout(resolve, 1500));
                await route.continue();
            });
            await page.route(/\/diff$/, async route => {
                await new Promise(resolve => setTimeout(resolve, 2500));
                await route.continue();
            });

            await page.locator('.build').first().locator('span').first().click();
            await page.waitForSelector('.screen');
            await takeScreenshot(page, 'Screen List - Loading');
            await page.waitForSelector('.image-wrapper.left img');
            await takeScreenshot(page, 'Screen List');

            await page.locator('input[data-testid="diff-check"]').check();
            await takeScreenshot(page, 'Screen List - Diff Mode - Loading');
            await page.waitForSelector('.image-wrapper.right .diff img');
            await takeScreenshot(page, 'Screen List - Diff Mode');

            await page.locator('input[data-testid="diff-check"]').uncheck();
            await page.locator('input[data-testid="changes-check"]').uncheck();
            await page.locator('.screen').last().locator('.image-wrapper img').waitFor({ timeout: 10000 });
            await takeFullPageScreenshot(page, 'Screen List - All Screens');

            // ── Review states ──
            // Re-enable the changes view so the per-screen review controls are available.
            await page.locator('input[data-testid="changes-check"]').check();

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
    });
});
