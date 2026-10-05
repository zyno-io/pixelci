import type { IAppShowResponse, IBuildResponse, IBuildScreenResponse } from '../../../src/openapi-client-generated';

export const appId = '00000000-0000-0000-0000-000000000001';
export const buildId = '00000000-0000-0000-0000-000000000002';
const branchId = '00000000-0000-0000-0000-000000000003';
const userId = '00000000-0000-0000-0000-000000000004';

export function createDesignApi(options: { anonymous?: boolean; onboarding?: boolean; admin?: boolean } = {}) {
    const app: IAppShowResponse = {
        id: appId,
        name: 'PixelCI UI',
        vcsId: appId,
        projectPath: 'signal24/products/pixelci',
        vcsProjectId: 230,
        defaultBranchId: branchId,
        deletedAt: null,
        commitUrlBase: null
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
    const screens: IBuildScreenResponse[] = ['Dashboard', 'Login'].map((name, index) => ({
        name,
        screenId: `screen-${index}`,
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
            reviewedAt: null
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
                      reviewedAt: null
                  }
                : undefined
    }));

    return (path: string, method = 'GET', body?: { reviewStatus: 'approved' | 'rejected'; comment: string }) => {
        const json = (data: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(data) });
        if (path === '/api/session/onboarding-status') return json({ isOnboarded: !options.onboarding });
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
        if (path === `/api/apps/${appId}`) return json(app);
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
        if (path.endsWith('/image') || path.endsWith('/diff')) {
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
