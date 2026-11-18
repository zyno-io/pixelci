import { expect, Page, test } from '@playwright/test';

import { signIn } from './fixtures/session';

test.describe('Accessibility', () => {
    test.beforeEach(async ({ page }) => {
        // Pre-auth before the first navigation so the single-provider login doesn't auto-redirect to OAuth.
        await signIn(page);

        await page.goto('/');
    });

    test('can navigate with keyboard', async ({ page }) => {
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');

        // Test tab navigation
        await page.keyboard.press('Tab');

        // Check if focus is visible
        const focusedElement = await page.evaluate(() => document.activeElement?.tagName);
        expect(focusedElement).toBeTruthy();
    });

    test('images have alt text', async ({ page }) => {
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');
        await page.locator('.build').first().locator('span').first().click();
        await page.waitForSelector('.screen');
        await page.waitForSelector('.image-wrapper img');

        const images = page.locator('.image-wrapper img');
        const count = await images.count();
        expect(count).toBeGreaterThan(0);

        // Check that content images have alt attributes
        for (let i = 0; i < count; i++) {
            const img = images.nth(i);
            const alt = await img.getAttribute('alt');
            // Alt can be empty string for decorative images, but should exist
            expect(alt !== null).toBeTruthy();
        }
    });

    test('interactive elements have appropriate roles', async ({ page }) => {
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');
        await page.locator('.build').first().locator('span').first().click();
        await page.waitForSelector('.screen');

        // Check checkboxes have correct role
        const diffCheckbox = page.locator('input[data-testid="diff-check"]');
        const role = await diffCheckbox.getAttribute('type');
        expect(role).toBe('checkbox');
    });

    test('maintains focus visibility in dark mode', async ({ page }) => {
        // This test runs in both light and dark mode via colorScheme parameter
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');

        await page.keyboard.press('Tab');

        // Focus should be visible in both modes
        const focusedElement = await page.evaluate(() => document.activeElement);
        expect(focusedElement).toBeTruthy();
    });

    test('color contrast is sufficient', async ({ page }) => {
        // This is a basic check - full accessibility testing would use axe-core or similar
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');

        // Check that text is visible (basic check)
        const buildElement = page.locator('.build').first();
        await expect(buildElement).toBeVisible();

        // Check text color is not transparent
        const color = await buildElement.evaluate(el => window.getComputedStyle(el).color);
        expect(color).not.toBe('rgba(0, 0, 0, 0)');
    });

    test('app row is reachable by Tab and Enter navigates', async ({ page }) => {
        await page.waitForSelector('.app');
        await tabTo(page, '.app');
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/apps\/[^/]+$/);
        await page.waitForSelector('.build');
    });

    test('build row is reachable by Tab and Enter navigates', async ({ page }) => {
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');
        await tabTo(page, '.build');
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/apps\/[^/]+\/builds\/[^/]+$/);
        await page.waitForSelector('.screen');
    });

    test('Escape closes the Add App modal and returns focus to the button', async ({ page }) => {
        const addApp = page.getByRole('button', { name: 'Add App', exact: true });
        await addApp.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(addApp).toBeFocused();
    });

    for (const colorScheme of ['light', 'dark'] as const) {
        test(`the mask editor is labelled, keyboard-operable and readable in ${colorScheme} mode`, async ({ page }) => {
            await page.emulateMedia({ colorScheme });
            await page.locator('.app').first().click();
            await page.getByTestId('browse-screens').click();
            // the seeded Homepage screen has one mask
            await page.getByTestId('gallery-tile').filter({ hasText: 'Homepage' }).click();
            const lightbox = page.getByTestId('lightbox');
            await expect(lightbox.getByTestId('mask-rect')).toHaveCount(1);

            // Structural checks, the ones an automated audit (axe) would make of this dialog: every control and every
            // mask has an accessible name, the mask layer and its live region have the right roles, ids are unique, and
            // nothing focusable is left without a role.
            const problems = await lightbox.evaluate(root => {
                const found: string[] = [];
                const nameOf = (el: Element) => {
                    const labelledBy = el.getAttribute('aria-labelledby');
                    const byId = labelledBy
                        ? labelledBy
                              .split(/\s+/)
                              .map(id => document.getElementById(id)?.textContent ?? '')
                              .join(' ')
                        : '';
                    const label = (el as HTMLInputElement).labels?.[0]?.textContent ?? '';
                    return (el.getAttribute('aria-label') || byId || label || el.getAttribute('title') || el.textContent || '').trim();
                };
                for (const el of root.querySelectorAll('button, input, select, textarea, [role="group"]')) {
                    if (!nameOf(el)) found.push(`no accessible name: ${el.tagName.toLowerCase()}[data-testid=${el.getAttribute('data-testid')}]`);
                }
                for (const el of root.querySelectorAll('[tabindex]')) {
                    const tag = el.tagName.toLowerCase();
                    const interactive = ['button', 'input', 'select', 'textarea', 'a'].includes(tag);
                    if (!interactive && !el.getAttribute('role'))
                        found.push(`focusable without a role: ${tag}[data-testid=${el.getAttribute('data-testid')}]`);
                }
                const ids = [...root.querySelectorAll('[id]')].map(el => el.id);
                for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) found.push(`duplicate id: ${id}`);
                const layer = root.querySelector('[data-testid="mask-layer"]');
                if (layer?.getAttribute('role') !== 'group' || !layer.getAttribute('aria-label'))
                    found.push('mask layer needs role=group and a label');
                const live = root.querySelector('[data-testid="mask-live"]');
                if (live?.getAttribute('role') !== 'status' || live.getAttribute('aria-live') !== 'polite') found.push('mask live region missing');
                for (const img of root.querySelectorAll('img')) if (img.getAttribute('alt') === null) found.push('image without alt');

                // Text contrast over the panel, composited through translucent backgrounds.
                const rgba = (value: string) => (value.match(/[\d.]+/g) ?? ['0', '0', '0', '0']).map(Number);
                const luminance = (c: number[]) =>
                    c.slice(0, 3).reduce((sum, channel, i) => {
                        const n = channel / 255;
                        return sum + (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
                    }, 0);
                for (const el of root.querySelectorAll(
                    '.lb-panel .lb-note, .lb-panel .lb-lead, .lb-panel .mask-num-label, .lb-panel .lb-check, .lb-panel h3'
                )) {
                    if (!el.textContent?.trim() || el.closest(':disabled, .disabled')) continue;
                    let background = [255, 255, 255];
                    const chain: Element[] = [];
                    for (let node: Element | null = el; node; node = node.parentElement) chain.unshift(node);
                    for (const node of chain) {
                        const color = rgba(getComputedStyle(node).backgroundColor);
                        const alpha = color[3] ?? 1;
                        background = background.map((channel, i) => color[i] * alpha + channel * (1 - alpha));
                    }
                    const fg = luminance(rgba(getComputedStyle(el).color));
                    const bg = luminance(background);
                    const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
                    if (ratio < 4.5)
                        found.push(`low contrast ${ratio.toFixed(2)}: ${el.className || el.tagName} "${el.textContent.trim().slice(0, 30)}"`);
                }
                return found;
            });
            expect(problems).toEqual([]);

            // Keyboard only: focus the mask, nudge it, and the dialog stays open on the same screen.
            const mask = lightbox.getByTestId('mask-rect');
            await mask.focus();
            await expect(mask).toBeFocused();
            const x = await lightbox.getByTestId('mask-x').inputValue();
            await page.keyboard.press('Shift+ArrowRight');
            await expect(lightbox.getByTestId('mask-x')).toHaveValue(String(Number(x) + 10));
            await expect(lightbox.getByTestId('mask-live')).toContainText('Mask 1');
            await expect(lightbox).toBeVisible();

            // the focus ring on a focused mask is the focus colour, not a status colour
            const stroke = await mask.locator('.mask-focus').evaluate(el => getComputedStyle(el).stroke);
            const focus = await page.evaluate(() => {
                const probe = document.createElement('i');
                probe.style.color = 'var(--focus)';
                document.body.appendChild(probe);
                const color = getComputedStyle(probe).color;
                probe.remove();
                return color;
            });
            expect(stroke).toBe(focus);
        });
    }
});

// Presses Tab until the focused element matches the selector (the nav and toolbar controls come first).
async function tabTo(page: Page, selector: string) {
    for (let i = 0; i < 30; i++) {
        await page.keyboard.press('Tab');
        if (await page.evaluate(sel => !!document.activeElement?.matches(sel), selector)) return;
    }
    throw new Error(`Tab never reached ${selector}`);
}
