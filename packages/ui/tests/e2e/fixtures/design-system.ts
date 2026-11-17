import type {
    IApprovalMinRole,
    IAppGalleryResponse,
    IAppShowResponse,
    IBuildResponse,
    IBuildScreenResponse,
    IMaskRect,
    IScreenMasksResponse
} from '../../../src/openapi-client-generated';

export const appId = '00000000-0000-0000-0000-000000000001';
export const buildId = '00000000-0000-0000-0000-000000000002';
const branchId = '00000000-0000-0000-0000-000000000003';
const userId = '00000000-0000-0000-0000-000000000004';

/** The region the mocked comparison reports as changed, in the mocked screenshots' 800x520 pixels. */
export const CHANGED_REGION = { x: 52, y: 168, width: 696, height: 60 };
const SCREENSHOT = { width: 800, height: 520 };

export const noMasks = (): IScreenMasksResponse => ({ masks: [], inheritAppMasks: true, version: 0, updatedAt: null, updatedByName: null });

/** Area of `rect` inside `within`, so the mocked comparison can discount masked pixels. */
function overlap(rect: IMaskRect, within: { x: number; y: number; width: number; height: number }) {
    const width = Math.min(rect.x + rect.width, within.x + within.width) - Math.max(rect.x, within.x);
    const height = Math.min(rect.y + rect.height, within.y + within.height) - Math.max(rect.y, within.y);
    return width > 0 && height > 0 ? width * height : 0;
}

export function createDesignApi(
    options: {
        anonymous?: boolean;
        onboarding?: boolean;
        admin?: boolean;
        canReview?: boolean;
        approvalMinRole?: IApprovalMinRole;
        /** Masks the app starts with. */
        appMasks?: IMaskRect[];
        /** Masks a screen starts with, by screen name, and whether it uses the app's. */
        screenMasks?: Record<string, { masks: IMaskRect[]; inheritAppMasks?: boolean }>;
        /** Masks stamped on the review screen's current build screens, by screen name. */
        appliedMasks?: Record<string, IMaskRect[]>;
        /** Every request the mocked API served, for assertions on what the UI sent. */
        requests?: { path: string; method: string; body?: unknown }[];
        /** Replaces the two build screens and the gallery with this many generated ones (for virtual scrolling). */
        screenCount?: number;
    } = {}
) {
    const app: IAppShowResponse = {
        id: appId,
        name: 'PixelCI UI',
        vcsId: appId,
        projectPath: 'signal24/products/pixelci',
        vcsProjectId: 230,
        defaultBranchId: branchId,
        deletedAt: null,
        approvalMinRole: options.approvalMinRole ?? 'write',
        commitUrlBase: null,
        canReview: options.canReview !== false,
        colorTolerance: null,
        shiftTolerance: null,
        diffPctTolerance: null,
        masks: options.appMasks ?? [],
        masksVersion: options.appMasks?.length ? 1 : 0,
        masksUpdatedAt: null,
        masksUpdatedById: null,
        instanceTolerances: { colorTolerance: 0.2, shiftTolerance: 1, diffPctTolerance: 0.01 }
    };
    const build: IBuildResponse = {
        id: buildId,
        branchId,
        branchName: 'main',
        createdAt: '2026-10-05T00:00:00Z',
        commitHash: 'c8036dfdd37c10c1914fb1f94c5f93acc3a77392',
        commitSubject: 'Apply the CI Dashboard design system',
        commitAuthor: 'Design Reviewer',
        status: 'needs review'
    };
    let screens: IBuildScreenResponse[] = ['Dashboard', 'Login'].map((name, index) => ({
        name,
        screenId: `screen-${index}`,
        tolerances: { colorTolerance: null, shiftTolerance: null, diffPctTolerance: null },
        masks: options.screenMasks?.[name]
            ? {
                  ...noMasks(),
                  masks: options.screenMasks[name].masks,
                  inheritAppMasks: options.screenMasks[name].inheritAppMasks ?? true,
                  version: 1,
                  updatedByName: 'Design Reviewer',
                  updatedAt: '2026-10-05T00:00:00Z'
              }
            : noMasks(),
        currentBuildScreen: {
            id: appId,
            buildId,
            screenId: `screen-${index}`,
            matchedBuildId: null,
            approvalBuildId: null,
            status: index === 0 ? 'needs review' : 'new',
            reviewStatus: null,
            reviewComment: null,
            reviewedById: null,
            reviewedAt: null,
            appliedMasks: options.appliedMasks?.[name] ?? null
        },
        referenceBuildScreen:
            index === 0
                ? {
                      id: appId,
                      buildId: appId,
                      screenId: 'screen-0',
                      matchedBuildId: null,
                      approvalBuildId: null,
                      status: 'changes approved',
                      reviewStatus: null,
                      reviewComment: null,
                      reviewedById: null,
                      reviewedAt: null,
                      appliedMasks: null
                  }
                : undefined
    }));

    // The app gallery: the two build screens as the baseline, plus enough others to fill a grid.
    let gallery: IAppGalleryResponse = {
        baselineBuild: { ...build, status: 'changes approved' },
        screens: ['Dashboard', 'Login', 'Settings', 'Billing', 'Team members', 'Audit log', 'Onboarding', 'Empty state'].map((name, index) => ({
            name,
            screenId: `screen-${index}`,
            tolerances: screens[index]?.tolerances ?? { colorTolerance: null, shiftTolerance: null, diffPctTolerance: null },
            masks: screens[index]?.masks ?? noMasks(),
            image: { buildId, sourceBuildId: buildId, isBaseline: index !== 7 }
        }))
    };

    if (options.screenCount) {
        const noTolerances = { colorTolerance: null, shiftTolerance: null, diffPctTolerance: null };
        const ids = Array.from({ length: options.screenCount }, (_, i) => ({
            i,
            name: `Screen ${String(i + 1).padStart(3, '0')}`,
            screenId: `screen-${String(i).padStart(3, '0')}`
        }));
        // The first needs review; the next 59 are unchanged; after that the three kinds repeat.
        const statusOf = (i: number) => (i === 0 ? 'needs review' : i < 60 ? 'no changes' : (['needs review', 'new', 'no changes'] as const)[i % 3]);
        const row = (screenId: string, forBuildId: string, status: string) => ({
            id: appId,
            buildId: forBuildId,
            screenId,
            matchedBuildId: null,
            approvalBuildId: null,
            status,
            reviewStatus: null,
            reviewComment: null,
            reviewedById: null,
            reviewedAt: null,
            appliedMasks: null
        });
        screens = ids.map(({ i, name, screenId }) => ({
            name,
            screenId,
            tolerances: noTolerances,
            masks: noMasks(),
            currentBuildScreen: row(screenId, buildId, statusOf(i)),
            referenceBuildScreen: statusOf(i) === 'new' ? undefined : row(screenId, appId, 'changes approved')
        })) as IBuildScreenResponse[];
        gallery = {
            ...gallery,
            screens: ids.map(({ name, screenId }) => ({
                name,
                screenId,
                tolerances: noTolerances,
                masks: noMasks(),
                image: { buildId, sourceBuildId: buildId, isBaseline: true }
            }))
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (path: string, method = 'GET', body?: any) => {
        const json = (data: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(data) });
        options.requests?.push({ path, method, body });
        if (path === '/api/session/onboarding-status')
            return json({ isOnboarded: !options.onboarding, setupEnabled: true, hasAdmin: !options.onboarding });
        if (path === '/api/session/me')
            return options.anonymous || options.onboarding
                ? json({ message: 'Unauthorized' }, 401)
                : json({ id: userId, name: 'Design Reviewer', isAdmin: options.admin !== false });
        if (path === '/api/session/providers')
            return json([
                { id: appId, name: 'GitLab' },
                { id: branchId, name: 'Team GitLab' }
            ]);
        if (path === '/api/apps')
            return json([
                { ...app, buildCount: 8 },
                { id: branchId, name: 'Marketing Site', buildCount: 3 }
            ]);
        if (path === `/api/apps/${appId}` && method === 'PUT' && body) {
            Object.assign(app, body);
            return json(app);
        }
        if (path === `/api/apps/${appId}`) return json(app);
        if (path === `/api/apps/${appId}/screens`) return json(gallery);
        if (path.endsWith('/tolerances') && method === 'PUT' && body) {
            const screenId = path.split('/').at(-2);
            for (const list of [screens, gallery.screens]) {
                const screen = list.find(item => item.screenId === screenId);
                if (screen) screen.tolerances = body;
            }
            return json(body);
        }
        if (path === `/api/apps/${appId}/masks` && method === 'PUT' && body) {
            if (body.baseVersion !== app.masksVersion) return json({ message: 'The masks were changed by someone else; reload and try again' }, 409);
            app.masks = body.masks;
            app.masksVersion += 1;
            return json({ masks: app.masks, version: app.masksVersion, updatedAt: '2026-10-06T00:00:00Z', updatedByName: 'Design Reviewer' });
        }
        if (path.endsWith('/masks') && method === 'PUT' && body) {
            if (options.canReview === false) return json({ message: 'Forbidden' }, 403);
            const screenId = path.split('/').at(-2);
            const current = screens.find(item => item.screenId === screenId);
            if (!current) return json({ message: 'Not found' }, 404);
            if (body.baseVersion !== current.masks.version)
                return json({ message: 'The masks were changed by someone else; reload and try again' }, 409);
            const saved: IScreenMasksResponse = {
                masks: body.masks,
                inheritAppMasks: body.inheritAppMasks,
                version: current.masks.version + 1,
                updatedAt: '2026-10-06T00:00:00Z',
                updatedByName: 'Design Reviewer'
            };
            for (const list of [screens, gallery.screens]) {
                const screen = list.find(item => item.screenId === screenId);
                if (screen) screen.masks = saved;
            }
            return json(saved);
        }
        // A fixed measured difference of 0.5%, so the verdict depends only on the allowance sent, and on how much of
        // the changed region the masks cover: that part is excluded, and so is its share of the total.
        if (path.endsWith('/compare') && method === 'POST' && body) {
            if (!Array.isArray(body.masks)) return json({ message: 'masks must be an array' }, 400);
            const masks: IMaskRect[] = body.masks;
            const maskedPixels = masks.reduce((sum, mask) => sum + overlap(mask, { x: 0, y: 0, ...SCREENSHOT }), 0);
            const coveredChange = masks.reduce((sum, mask) => sum + overlap(mask, CHANGED_REGION), 0);
            const changedArea = CHANGED_REGION.width * CHANGED_REGION.height;
            const diffPixels = Math.round(2080 * (1 - Math.min(1, coveredChange / changedArea)));
            const diffPct = (diffPixels / (416000 - maskedPixels)) * 100;
            return json({
                diffPct,
                diffPixels,
                totalPixels: 416000,
                shiftTolerantPixels: body.shiftTolerance > 0 ? 312 : 0,
                maskedPixels,
                passes: diffPct <= body.diffPctTolerance,
                diffImage:
                    'data:image/svg+xml;utf8,' +
                    encodeURIComponent(
                        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520"><rect width="800" height="520" fill="#fef1ee"/><rect x="52" y="168" width="696" height="60" fill="#ff0000"/></svg>'
                    )
            });
        }
        if (path === `/api/apps/${appId}/branches`) return json([{ id: branchId, name: 'main' }]);
        if (path === `/api/apps/${appId}/builds`)
            return json(
                ['needs review', 'changes approved', 'no changes', 'failed', 'processing', 'draft'].map((status, i) => ({
                    ...build,
                    id: i === 0 ? buildId : `build-${i}`,
                    status
                }))
            );
        if (path === `/api/apps/${appId}/builds/${buildId}`) return json(build);
        if (path.endsWith('/screens')) return json(screens);
        if (path.endsWith('/review') && method === 'POST' && body) {
            const screen = screens.find(item => path.endsWith(`/${item.screenId}/review`));
            if (screen?.currentBuildScreen) {
                Object.assign(screen.currentBuildScreen, { reviewStatus: body.reviewStatus, reviewComment: body.comment, reviewedById: userId });
                return json(screen.currentBuildScreen);
            }
        }
        if (path.endsWith('/image') || path.endsWith('/thumbnail') || path.endsWith('/diff')) {
            const diff = path.endsWith('/diff');
            return {
                status: 200,
                contentType: 'image/svg+xml',
                body: `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520"><rect width="800" height="520" fill="${diff ? '#fef1ee' : '#f6f7f9'}"/><rect x="28" y="28" width="744" height="48" rx="8" fill="#ffffff"/><text x="48" y="58" font-family="sans-serif" font-size="18" fill="#15171c">PixelCI</text><rect x="28" y="100" width="744" height="380" rx="12" fill="#ffffff"/><text x="52" y="140" font-family="sans-serif" font-size="22" fill="#15171c">${diff ? 'Visual changes' : 'Visual test dashboard'}</text><rect x="52" y="168" width="696" height="60" rx="8" fill="${diff ? '#fbd0c5' : '#eef4ff'}"/></svg>`
            };
        }
        if (path === '/api/admin/vcs-integrations') return json([{ id: appId, name: 'Signal24 GitLab', platform: 'gitlab' }]);
        if (path === '/api/admin/users')
            return json([{ id: userId, name: 'Design Reviewer', vcsName: 'Signal24 GitLab', isAdmin: true, lastLoginAt: '2026-10-05T00:00:00Z' }]);
        return json({ message: `Unmocked endpoint: ${method} ${path}` }, 404);
    };
}
