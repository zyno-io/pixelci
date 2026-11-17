import { expect, type Locator, type Page, test } from '@playwright/test';

import { appId, buildId, CHANGED_REGION, createDesignApi } from './fixtures/design-system';

type Requests = NonNullable<NonNullable<Parameters<typeof createDesignApi>[0]>['requests']>;

const IMAGE_WIDTH = 800;
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

async function mockApi(page: Page, options: Parameters<typeof createDesignApi>[0] = {}) {
    const respond = createDesignApi(options);
    await page.route('**/api/**', async route => {
        const request = route.request();
        await route.fulfill(respond(new URL(request.url()).pathname, request.method(), request.postDataJSON() ?? undefined));
    });
}

/** Opens the lightbox on a screen of the mocked build, ready to edit masks. */
async function openLightbox(page: Page, name = 'Dashboard') {
    await page.goto(`/apps/${appId}/builds/${buildId}`);
    await page.locator('.screen').filter({ hasText: name }).getByTestId('open-tolerance').click();
    await expect(page.getByTestId('lightbox')).toBeVisible();
    await expect(page.getByTestId('mask-layer')).toBeVisible();
}

/** Where a point of the screenshot (in its own pixels) is on the page. */
async function imagePoint(page: Page, x: number, y: number) {
    const box = (await page.getByTestId('lightbox-canvas').boundingBox())!;
    const k = box.width / IMAGE_WIDTH;
    return { x: box.x + x * k, y: box.y + y * k };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
}

/** Draws a mask over the region of the screenshot the mocked comparison reports as changed. */
async function drawOverChange(page: Page) {
    await page.getByTestId('mask-draw').click();
    const { x, y, width, height } = CHANGED_REGION;
    await drag(page, await imagePoint(page, x - 12, y - 12), await imagePoint(page, x + width + 12, y + height + 12));
}

const field = (page: Page, key: 'x' | 'y' | 'width' | 'height', row = 0) => page.getByTestId('mask-row').nth(row).getByTestId(`mask-${key}`);

async function values(page: Page, row = 0) {
    return {
        x: Number(await field(page, 'x', row).inputValue()),
        y: Number(await field(page, 'y', row).inputValue()),
        width: Number(await field(page, 'width', row).inputValue()),
        height: Number(await field(page, 'height', row).inputValue())
    };
}

function lastCompare(requests: Requests) {
    return requests.filter(r => r.path.endsWith('/compare')).at(-1)?.body as {
        masks: { id: string; x: number; y: number; width: number; height: number }[];
    };
}

const rect = (id: string, x: number, y: number, width: number, height: number, label: string | null = null) => ({ id, x, y, width, height, label });

test.describe('mask editor, pointer', () => {
    test('draw a mask, see the preview pass, save it and find it again after a reload', async ({ page }) => {
        const requests: Requests = [];
        await mockApi(page, { requests });
        await openLightbox(page);

        await expect(page.getByTestId('tolerance-preview')).toContainText('Would be flagged');
        expect(lastCompare(requests).masks).toEqual([]);

        await drawOverChange(page);
        await expect(page.getByTestId('mask-row')).toHaveCount(1);
        await expect(page.getByTestId('mask-rect')).toHaveCount(1);
        await expect(page.getByTestId('mask-count')).toHaveText('1 mask');

        // the comparison ran against the drawn mask, and excludes what is under it
        await expect(page.getByTestId('tolerance-preview')).toContainText('Would pass');
        await expect(page.getByTestId('preview-masked')).toContainText('px masked');
        await expect(page.getByTestId('mask-preview')).toContainText('Would pass');
        expect(lastCompare(requests).masks).toHaveLength(1);
        expect((await values(page)).width).toBeGreaterThan(CHANGED_REGION.width);

        await expect(page.getByText('Unsaved changes')).toBeVisible();
        await page.getByTestId('masks-save').click();
        await expect(page.getByText('Unsaved changes')).toHaveCount(0);

        const save = requests.find(r => r.method === 'PUT' && r.path.endsWith('/screen-0/masks'));
        expect(save?.body).toMatchObject({ inheritAppMasks: true, baseVersion: 0 });
        expect((save!.body as { masks: unknown[] }).masks).toHaveLength(1);

        await page.reload();
        await page.locator('.screen').filter({ hasText: 'Dashboard' }).getByTestId('open-tolerance').click();
        await expect(page.getByTestId('mask-count')).toHaveText('1 mask');
        await expect(page.getByTestId('mask-saved-by')).toContainText('Design Reviewer');
    });

    test('a mask can be moved and resized with its handles, and the comparison waits for the pointer to come up', async ({ page }) => {
        const requests: Requests = [];
        await mockApi(page, { requests, screenMasks: { Dashboard: { masks: [rect(ID_A, 100, 300, 200, 100)] } } });
        await openLightbox(page);
        await expect(page.getByTestId('tolerance-preview')).toContainText('Would be flagged');
        const comparesBefore = requests.filter(r => r.path.endsWith('/compare')).length;
        expect(comparesBefore).toBeGreaterThan(0);

        const rectBox = (await page.getByTestId('mask-rect').locator('.mask-edge-a').boundingBox())!;
        const startX = rectBox.x + rectBox.width / 2;
        const startY = rectBox.y + rectBox.height / 2;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX + 20, startY + 10, { steps: 4 });
        await page.waitForTimeout(600);
        // still dragging: no comparison per movement
        expect(requests.filter(r => r.path.endsWith('/compare')).length).toBe(comparesBefore);
        await page.mouse.up();

        const moved = await values(page);
        expect(moved.x).toBeGreaterThan(100);
        expect(moved.y).toBeGreaterThan(300);
        expect(moved.width).toBe(200);
        await expect.poll(() => requests.filter(r => r.path.endsWith('/compare')).length).toBeGreaterThan(comparesBefore);

        // the south-east handle grows it
        const handle = (await page.getByTestId('mask-handle-se').boundingBox())!;
        await drag(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, { x: handle.x + 60, y: handle.y + 40 });
        const grown = await values(page);
        expect(grown.width).toBeGreaterThan(200);
        expect(grown.height).toBeGreaterThan(100);
        expect(grown.x).toBe(moved.x);
    });

    test('Escape cancels a draw in progress without closing the lightbox', async ({ page }) => {
        await mockApi(page);
        await openLightbox(page);

        await page.getByTestId('mask-draw').click();
        const from = await imagePoint(page, 100, 300);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + 80, from.y + 60, { steps: 3 });
        await expect(page.getByTestId('mask-draft')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('mask-draft')).toHaveCount(0);
        await page.mouse.up();

        await expect(page.getByTestId('lightbox')).toBeVisible();
        await expect(page.getByTestId('mask-rect')).toHaveCount(0);
        await expect(page.getByTestId('mask-draw')).toHaveAttribute('aria-pressed', 'false');
    });

    test('Escape in draw mode leaves draw mode, and only the next Escape closes the lightbox', async ({ page }) => {
        await mockApi(page);
        await openLightbox(page);
        await page.getByTestId('mask-draw').click();
        await expect(page.getByTestId('mask-draw')).toHaveAttribute('aria-pressed', 'true');
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('lightbox')).toBeVisible();
        await expect(page.getByTestId('mask-draw')).toHaveAttribute('aria-pressed', 'false');
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('lightbox')).toHaveCount(0);
    });
});

test.describe('mask editor, keyboard', () => {
    test('N adds a mask, arrows nudge it, Alt resizes it, Delete removes it', async ({ page }) => {
        await mockApi(page);
        await openLightbox(page);
        const name = await page.locator('.lb-name').textContent();

        await page.keyboard.press('n');
        await expect(page.getByTestId('mask-rect')).toHaveCount(1);
        await expect(page.getByTestId('mask-rect')).toBeFocused();
        await expect(page.getByTestId('mask-rect')).toHaveAttribute('aria-label', /^Mask 1, x \d+, y \d+, \d+ × \d+ px$/);
        const start = await values(page);

        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowDown');
        expect(await values(page)).toEqual({ ...start, x: start.x + 2, y: start.y + 1 });

        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Shift+ArrowRight');
        expect(await values(page)).toEqual({ ...start, x: start.x + 12, y: start.y + 11 });

        await page.keyboard.press('Alt+ArrowRight');
        await page.keyboard.press('Alt+Shift+ArrowDown');
        await page.keyboard.press('Alt+ArrowLeft');
        await page.keyboard.press('Alt+ArrowLeft');
        const resized = await values(page);
        expect(resized).toEqual({ ...start, x: start.x + 12, y: start.y + 11, width: start.width - 1, height: start.height + 10 });
        await expect(page.getByTestId('mask-rect')).toHaveAttribute(
            'aria-label',
            `Mask 1, x ${resized.x}, y ${resized.y}, ${resized.width} × ${resized.height} px`
        );
        await expect(page.getByTestId('mask-live')).toContainText(`${resized.width} × ${resized.height} px`);

        // none of that stepped to another screen or closed the lightbox
        await expect(page.locator('.lb-name')).toHaveText(name!);
        await expect(page.locator('.lb-count')).toHaveText('1 of 2');

        await page.keyboard.press('Delete');
        await expect(page.getByTestId('mask-rect')).toHaveCount(0);
        await expect(page.getByTestId('mask-row')).toHaveCount(0);
        await expect(page.getByTestId('mask-live')).toContainText('Removed mask 1');
        await expect(page.getByTestId('mask-empty')).toBeVisible();
        await expect(page.getByTestId('lightbox')).toBeVisible();
    });

    test('arrows on a mask do not step the lightbox, and Escape only leaves the mask', async ({ page }) => {
        await mockApi(page, { screenMasks: { Dashboard: { masks: [rect(ID_A, 100, 300, 200, 100)] } } });
        await openLightbox(page);
        await expect(page.locator('.lb-count')).toHaveText('1 of 2');

        await page.getByTestId('mask-rect').focus();
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await expect(page.locator('.lb-count')).toHaveText('1 of 2');
        expect((await values(page)).x).toBe(101);

        // Escape from a mask returns to the stage rather than closing the dialog
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('lightbox')).toBeVisible();
        await expect(page.getByTestId('lightbox-stage')).toBeFocused();

        // and from the stage the arrows step between screens again
        await page.keyboard.press('ArrowRight');
        await expect(page.locator('.lb-count')).toHaveText('2 of 2');
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('lightbox')).toHaveCount(0);
    });

    test('M hides and shows the mask layer, and N is ignored while typing in a field', async ({ page }) => {
        await mockApi(page, { screenMasks: { Dashboard: { masks: [rect(ID_A, 100, 300, 200, 100)] } } });
        await openLightbox(page);
        await expect(page.getByTestId('mask-rect')).toHaveCount(1);

        await page.keyboard.press('m');
        await expect(page.getByTestId('mask-rect')).toHaveCount(0);
        await expect(page.getByTestId('mask-toggle-layer')).toContainText('Show masks');
        await page.keyboard.press('m');
        await expect(page.getByTestId('mask-rect')).toHaveCount(1);

        await page.getByTestId('mask-label').fill('nm');
        await expect(page.getByTestId('mask-row')).toHaveCount(1);
        await expect(page.getByTestId('mask-label')).toHaveValue('nm');
    });

    test('the X, Y, W and H fields place a mask precisely and reject bad values', async ({ page }) => {
        const requests: Requests = [];
        await mockApi(page, { requests, screenMasks: { Dashboard: { masks: [rect(ID_A, 100, 300, 200, 100)] } } });
        await openLightbox(page);

        await field(page, 'x').fill('52');
        await field(page, 'y').fill('168');
        await field(page, 'width').fill('696');
        await field(page, 'height').fill('60');
        await page.getByTestId('mask-label').fill('Chart');
        await expect(page.getByTestId('tolerance-preview')).toContainText('Would pass');
        expect(lastCompare(requests).masks[0]).toMatchObject({ x: 52, y: 168, width: 696, height: 60 });

        await field(page, 'width').fill('0');
        await expect(field(page, 'width')).toHaveAttribute('aria-invalid', 'true');
        await expect(page.getByRole('alert').filter({ hasText: 'W is at least 1' })).toBeVisible();
        await expect(page.getByTestId('masks-save')).toBeDisabled();
        await expect(page.getByTestId('tolerance-preview')).toContainText('Correct the highlighted value');

        await field(page, 'width').fill('1.5');
        await expect(page.getByRole('alert').filter({ hasText: 'Use whole pixels' })).toBeVisible();
        await field(page, 'width').fill('696');
        await expect(page.getByTestId('masks-save')).toBeEnabled();

        await page.getByTestId('masks-save').click();
        const save = requests.find(r => r.method === 'PUT' && r.path.endsWith('/masks'));
        expect((save!.body as { masks: unknown[] }).masks).toEqual([{ ...rect(ID_A, 52, 168, 696, 60), label: 'Chart' }]);
    });
});

test.describe('mask editor, state', () => {
    test('unsaved masks are kept per screen while the lightbox is open', async ({ page }) => {
        await mockApi(page);
        await openLightbox(page);
        await page.keyboard.press('n');
        await expect(page.getByTestId('mask-row')).toHaveCount(1);

        await page.getByTestId('lightbox-next').click();
        await expect(page.locator('.lb-name')).toHaveText('Login');
        await expect(page.getByTestId('mask-row')).toHaveCount(0);

        await page.getByTestId('lightbox-prev').click();
        await expect(page.getByTestId('mask-row')).toHaveCount(1);
        await expect(page.getByText('Unsaved changes')).toBeVisible();
    });

    test('the app masks are drawn dashed and can be opted out of, which the preview follows', async ({ page }) => {
        const requests: Requests = [];
        await mockApi(page, {
            requests,
            appMasks: [rect(ID_B, 52, 168, 696, 60)],
            screenMasks: { Dashboard: { masks: [rect(ID_A, 10, 10, 50, 20)] } }
        });
        await openLightbox(page);

        await expect(page.getByTestId('app-mask-rect')).toHaveCount(1);
        await expect(page.getByTestId('mask-rect')).toHaveCount(1);
        await expect(page.getByTestId('app-mask-count')).toContainText('1 mask');
        await expect(page.getByTestId('tolerance-preview')).toContainText('Would pass');
        expect(lastCompare(requests).masks.map(m => m.id)).toEqual([ID_B, ID_A]);

        await page.getByTestId('mask-inherit').uncheck();
        await expect(page.getByTestId('app-mask-rect')).toHaveCount(0);
        await expect(page.getByTestId('tolerance-preview')).toContainText('Would be flagged');
        expect(lastCompare(requests).masks.map(m => m.id)).toEqual([ID_A]);

        await page.getByTestId('masks-save').click();
        const save = requests.find(r => r.method === 'PUT' && r.path.endsWith('/screen-0/masks'));
        expect(save?.body).toMatchObject({ inheritAppMasks: false, baseVersion: 1 });
    });

    test('masks partly outside the screenshot are called out', async ({ page }) => {
        await mockApi(page, { screenMasks: { Dashboard: { masks: [rect(ID_A, 700, 10, 200, 40), rect(ID_B, 2000, 2000, 10, 10)] } } });
        await openLightbox(page);
        await expect(page.getByTestId('mask-outside')).toContainText('1 mask is partly outside this screenshot');
        await expect(page.getByTestId('mask-outside')).toContainText('1 mask is entirely outside this screenshot');
    });

    test('masks covering most of a screenshot are called out', async ({ page }) => {
        await mockApi(page, { screenMasks: { Dashboard: { masks: [rect(ID_A, 0, 0, 800, 400)] } } });
        await openLightbox(page);
        await expect(page.getByTestId('mask-coverage')).toContainText('77%');
    });

    test('the mask layer follows the zoom levels', async ({ page }) => {
        await mockApi(page, { screenMasks: { Dashboard: { masks: [rect(ID_A, 100, 100, 200, 100)] } } });
        await openLightbox(page);
        for (const zoom of ['fit', '100', '200']) {
            await page.getByTestId('lightbox-zoom').selectOption(zoom);
            const image = (await page.getByTestId('lightbox-canvas').locator('img').boundingBox())!;
            const layer = (await page.getByTestId('mask-layer').boundingBox())!;
            const outline = (await page.getByTestId('mask-rect').locator('.mask-edge-a').boundingBox())!;
            expect(Math.abs(layer.width - image.width)).toBeLessThan(1);
            expect(Math.abs(layer.height - image.height)).toBeLessThan(1);
            // 200 of 800 px wide, so a quarter of the image however it is scaled (the outline stroke adds a few px)
            expect(Math.abs(outline.width / image.width - 0.25)).toBeLessThan(0.02);
        }
    });

    test('a stale save reloads the masks and says so', async ({ page }) => {
        const requests: Requests = [];
        await mockApi(page, { requests });
        await openLightbox(page);

        // someone else saves first, from another tab
        await page.evaluate(async id => {
            await fetch(`/api/apps/${id}/screens/screen-0/masks`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ masks: [], inheritAppMasks: true, baseVersion: 0 })
            });
        }, appId);

        await page.keyboard.press('n');
        await page.getByTestId('masks-save').click();
        await expect(page.getByText("Someone else changed this screen's masks")).toBeVisible();
        await expect(page.getByText('your unsaved changes were discarded')).toBeVisible();
        await page.getByRole('button', { name: 'OK', exact: true }).click();
        await expect(page.getByTestId('mask-row')).toHaveCount(0);
        await expect(page.getByText('Unsaved changes')).toHaveCount(0);

        // now at the current version, a save goes through
        await page.keyboard.press('n');
        await page.getByTestId('masks-save').click();
        await expect(page.getByText('Unsaved changes')).toHaveCount(0);
        const saves = requests.filter(r => r.method === 'PUT' && r.path.endsWith('/screen-0/masks'));
        expect(saves.at(-1)?.body).toMatchObject({ baseVersion: 1 });
    });
});

test.describe('app masks', () => {
    test('an admin edits the app masks from the lightbox and saves them separately', async ({ page }) => {
        const requests: Requests = [];
        await mockApi(page, { requests });
        await openLightbox(page);

        await page.getByTestId('app-masks-edit').click();
        await expect(page.getByTestId('app-mask-mode')).toContainText('apply to every screen');
        await expect(page.getByRole('heading', { name: 'App masks' })).toBeVisible();
        await page.getByTestId('mask-add').click();
        await expect(page.getByTestId('mask-row')).toHaveCount(1);
        await expect(page.getByTestId('masks-save')).toHaveText('Save app masks');

        // the app's draft is in effect for the preview even before it is saved
        await expect.poll(() => lastCompare(requests)?.masks.length).toBe(1);

        await page.getByTestId('masks-save').click();
        const save = requests.find(r => r.method === 'PUT' && r.path === `/api/apps/${appId}/masks`);
        expect(save?.body).toMatchObject({ baseVersion: 0 });
        expect((save!.body as { masks: unknown[] }).masks).toHaveLength(1);
        // the screen's own save was not involved
        expect(requests.some(r => r.method === 'PUT' && r.path.includes('/screens/'))).toBe(false);

        await page.getByTestId('app-masks-done').click();
        await expect(page.getByTestId('app-mask-rect')).toHaveCount(1);
        await expect(page.getByTestId('app-mask-count')).toContainText('1 mask');
        await expect(page.getByTestId('mask-row')).toHaveCount(0);
    });

    test('people who are not admins cannot edit the app masks', async ({ page }) => {
        await mockApi(page, { admin: false, appMasks: [rect(ID_B, 52, 168, 696, 60)] });
        await openLightbox(page);
        await expect(page.getByTestId('mask-draw')).toBeVisible();
        await expect(page.getByTestId('app-masks-edit')).toHaveCount(0);
        // but the app's masks are still drawn, read-only
        await expect(page.getByTestId('app-mask-rect')).toHaveCount(1);
    });
});

test.describe('without the review role', () => {
    test('masks can be seen but not edited', async ({ page }) => {
        await mockApi(page, { admin: false, canReview: false, screenMasks: { Dashboard: { masks: [rect(ID_A, 100, 300, 200, 100)] } } });
        await openLightbox(page);

        await expect(page.getByTestId('mask-outline')).toHaveCount(1);
        await expect(page.getByTestId('mask-readonly')).toContainText('Only people who can review this app can change masks.');
        await expect(page.getByTestId('mask-draw')).toHaveCount(0);
        await expect(page.getByTestId('mask-add')).toHaveCount(0);
        await expect(page.getByTestId('masks-save')).toHaveCount(0);
        await expect(page.getByTestId('app-masks-edit')).toHaveCount(0);
        await expect(page.getByTestId('mask-x')).toBeDisabled();
        await expect(page.getByTestId('mask-inherit')).toBeDisabled();
        // the layer is an outline: nothing to focus, and the N key adds nothing
        await expect(page.getByTestId('mask-outline')).not.toHaveAttribute('tabindex', /.*/);
        await page.keyboard.press('n');
        await expect(page.getByTestId('mask-row')).toHaveCount(1);
        await expect(page.getByTestId('mask-outline')).toHaveCount(1);
    });
});

test.describe('read-only displays', () => {
    test('the review screen outlines what was ignored, and clicks still reach the screenshot', async ({ page }) => {
        const applied = [rect(ID_A, 52, 168, 696, 60, 'Chart')];
        await mockApi(page, { appliedMasks: { Dashboard: applied } });
        await page.goto(`/apps/${appId}/builds/${buildId}`);
        const screen = page.locator('.screen').filter({ hasText: 'Dashboard' });

        await expect(screen.getByTestId('screen-masked')).toHaveText('Masked');
        await expect(page.locator('.screen').filter({ hasText: 'Login' }).getByTestId('screen-masked')).toHaveCount(0);
        // over both panes
        const layers = screen.getByTestId('applied-masks');
        await expect(layers).toHaveCount(2);
        await expect(layers.first()).toHaveCSS('pointer-events', 'none');
        await expect(layers.first()).toHaveAttribute('aria-hidden', 'true');
        await expect(layers.first().getByTestId('mask-outline')).toHaveCount(1);

        // Shift+click on the screenshot still toggles the diff, through the outline
        const target = (await layers.last().boundingBox())!;
        await expect(page.getByTestId('diff-check')).not.toBeChecked();
        await page.keyboard.down('Shift');
        await page.mouse.click(target.x + target.width * 0.5, target.y + target.height * 0.5);
        await page.keyboard.up('Shift');
        await expect(page.getByTestId('diff-check')).toBeChecked();
        // the outline is still there over the diff
        await expect(screen.locator('.diff').getByTestId('applied-masks')).toHaveCount(1);
    });

    test('the gallery tags masked screens and the Custom filter counts them', async ({ page }) => {
        await mockApi(page, {
            screenMasks: { Dashboard: { masks: [rect(ID_A, 100, 300, 200, 100)] }, Login: { masks: [], inheritAppMasks: false } }
        });
        await page.goto(`/apps/${appId}/screens`);
        await expect(page.getByTestId('gallery-tile')).toHaveCount(8);
        await expect(page.getByTestId('gallery-tile').filter({ hasText: 'Dashboard' }).getByTestId('tile-masked')).toHaveText('Masked');
        await expect(page.getByTestId('tile-masked')).toHaveCount(1);

        // masks and opting out of the app's both make a screen custom
        await expect(page.getByTestId('gallery-filter-custom')).toContainText('Custom (2)');
        await page.getByTestId('gallery-filter-custom').click();
        await expect(page.getByTestId('gallery-tile')).toHaveCount(2);
    });

    test('masks drawn in the gallery lightbox tag the tile once saved', async ({ page }) => {
        await mockApi(page);
        await page.goto(`/apps/${appId}/screens`);
        await page.getByTestId('gallery-tile').filter({ hasText: 'Dashboard' }).click();
        await expect(page.getByTestId('lightbox')).toBeVisible();
        // no reference to compare in the gallery, so there is no preview to run, but masks can still be saved
        await expect(page.getByTestId('mask-layer')).toBeVisible();
        await page.keyboard.press('n');
        await page.getByTestId('masks-save').click();
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('lightbox')).toHaveCount(0);
        await expect(page.getByTestId('gallery-tile').filter({ hasText: 'Dashboard' }).getByTestId('tile-masked')).toBeVisible();
    });
});

test.describe('phone width', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('the editor fits and works', async ({ page }) => {
        await mockApi(page);
        await openLightbox(page);

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);

        await page.getByTestId('mask-add').click();
        await expect(page.getByTestId('mask-row')).toHaveCount(1);
        const stage = (await page.getByTestId('lightbox-stage').boundingBox())!;
        const canvas = (await page.getByTestId('lightbox-canvas').boundingBox())!;
        expect(canvas.width).toBeLessThanOrEqual(stage.width);
        expect(canvas.x).toBeGreaterThanOrEqual(stage.x);
        await expectInside(page.getByTestId('lightbox'), page.getByTestId('mask-draw'));
        await expectInside(page.getByTestId('lightbox'), field(page, 'width'));

        // drawing by pointer works at this size too
        await page.getByTestId('mask-draw').click();
        await page.getByTestId('lightbox-stage').scrollIntoViewIfNeeded();
        await drag(page, await imagePoint(page, 60, 170), await imagePoint(page, 300, 230));
        await expect(page.getByTestId('mask-row')).toHaveCount(2);
    });
});

async function expectInside(container: Locator, inner: Locator) {
    await inner.scrollIntoViewIfNeeded();
    const outer = (await container.boundingBox())!;
    const box = (await inner.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(outer.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
}
