/**
 * Response canary: seeds secret-looking values (OAuth client secrets, a GitHub App private key, a user's VCS session
 * tokens, CI tokens and their hashes) and fires a request at EVERY route, asserting that none of them ever appear in a
 * response. Responses are serialized unfiltered, so any controller that returns an entity (or spreads one) trips this.
 *
 * Routes are enumerated from the router: a route without a case below fails the test ("add a canary case").
 */
import { HttpRequest, RequestBuilder } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, JWT, TestingHelpers } from '@zyno-io/ts-server-foundation';
import { createHash, generateKeyPairSync, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import { CoreAppOptions } from '../../src/app';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { BuildEntity } from '../../src/entities/Build.entity';
import { BuildScreenEntity } from '../../src/entities/BuildScreen.entity';
import { UserEntity } from '../../src/entities/User.entity';
import { VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { configureTestDatabase } from './db-defaults';

process.env.CI = 'true';
process.env.REDIS_PREFIX = 'pixelci_test';

configureTestDatabase();

const RAND = randomBytes(6).toString('hex');
const CANARY_GITLAB_SECRET = `CANARY-cs-${RAND}`;
const CANARY_GITHUB_SECRET = `CANARY-ghcs-${RAND}`;
const CANARY_ACCESS_TOKEN = `CANARY-at-${RAND}`;
const CANARY_REFRESH_TOKEN = `CANARY-rt-${RAND}`;
const CI_TOKEN = 'CANARY-ci';
const CI_READ_TOKEN = 'CANARY-ci-reader';
const CI_TOKEN_B2 = 'CANARY-ci-b2';
const PAT = 'glpat-canary-pat';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

const { privateKey: GITHUB_PRIVATE_KEY } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});
const PEM_BODY = GITHUB_PRIVATE_KEY.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');

const FORBIDDEN_VALUES = [
    CANARY_GITLAB_SECRET,
    CANARY_GITHUB_SECRET,
    CANARY_ACCESS_TOKEN,
    CANARY_REFRESH_TOKEN,
    sha256(CI_TOKEN),
    sha256(CI_READ_TOKEN),
    sha256(CI_TOKEN_B2),
    PEM_BODY.slice(0, 64),
    PEM_BODY.slice(64, 128)
];
const FORBIDDEN_KEYS = new Set([
    'ciTokenHash',
    'ciReadTokenHashes',
    'ciJobId',
    'vcsSession',
    'clientSecret',
    'privateKey',
    'accessToken',
    'refreshToken'
]);

const GL_ID = '00000000-0000-0000-0000-000000000000';
const GH_ID = 'c4a4a4a4-0000-4000-8000-0000000000a1';
const GL_SPARE_ID = 'c4a4a4a4-0000-4000-8000-0000000000a2';
const ADMIN_ID = 'c4a4a4a4-0000-4000-8000-000000000001';
const OTHER_USER_ID = 'c4a4a4a4-0000-4000-8000-000000000002';
const APP_ID = 'c4a4a4a4-0000-4000-8000-000000000010';
const SPARE_APP_ID = 'c4a4a4a4-0000-4000-8000-000000000011';
const MAIN_BRANCH_ID = 'c4a4a4a4-0000-4000-8000-000000000020';
const PROJECT_PATH = 'group/canary';

const JOBS: Record<string, { id: number; ref: string; sha: string; title: string }> = {
    [CI_TOKEN]: { id: 1, ref: 'main', sha: 'a'.repeat(40), title: 'canary main' },
    [CI_READ_TOKEN]: { id: 2, ref: 'main', sha: 'a'.repeat(40), title: 'canary main' },
    [CI_TOKEN_B2]: { id: 3, ref: 'b2', sha: 'b'.repeat(40), title: 'canary b2' }
};

let mockGitLabServer: Server;
let mockGitLabPort: number;

run()
    .then(() => {
        console.log('\nAll response canary tests passed!');
        process.exit(0);
    })
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

function createMockGitLab(): Promise<void> {
    return new Promise(resolve => {
        mockGitLabServer = createServer((req: IncomingMessage, res: ServerResponse) => {
            const url = req.url ?? '';
            const json = (status: number, body: unknown) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
            };

            if (url === '/api/v4/job') {
                const job = JOBS[String(req.headers['job-token'])];
                if (!job) return json(401, { message: 'Unauthorized' });
                return json(200, {
                    id: job.id,
                    ref: job.ref,
                    pipeline: { project_id: 1, sha: job.sha },
                    commit: { title: job.title, author_name: 'canary' }
                });
            }
            if (url === '/api/v4/user') {
                if (req.headers['private-token'] !== PAT) return json(401, { message: 'Unauthorized' });
                return json(200, { id: 4242, username: 'canary', name: 'Canary Admin' });
            }
            if (req.method === 'POST' && /^\/api\/v4\/projects\/[^/]+\/jobs\/[^/]+\/retry$/.test(url)) {
                return json(200, { id: 999, pipeline: { id: 7 } });
            }
            if (req.method === 'POST' && url === '/oauth/token') return json(400, { error: 'invalid_grant' });
            if (/^\/api\/v4\/projects\/[^/?]+\/members\/all\//.test(url)) {
                return json(200, { id: 4242, state: 'active', membership_state: 'active', access_level: 40 });
            }
            if (url.startsWith('/api/v4/projects?')) {
                return json(200, [
                    {
                        id: 1,
                        name: 'canary',
                        path_with_namespace: PROJECT_PATH,
                        web_url: `http://x/${PROJECT_PATH}`,
                        description: '',
                        default_branch: 'main'
                    }
                ]);
            }
            if (url.startsWith('/api/v4/projects/')) {
                return json(200, {
                    id: 1,
                    name: 'canary',
                    path_with_namespace: PROJECT_PATH,
                    web_url: `http://x/${PROJECT_PATH}`,
                    description: '',
                    default_branch: 'main',
                    permissions: { project_access: { access_level: 40, notification_level: 3 }, group_access: null }
                });
            }
            res.writeHead(404);
            res.end('Not found');
        });
        mockGitLabServer.listen(0, () => {
            mockGitLabPort = (mockGitLabServer.address() as { port: number }).port;
            resolve();
        });
    });
}

type Facade = ReturnType<typeof TestingHelpers.createTestingFacade>;

interface ICtx {
    buildId: string;
    b2BuildId: string;
    screenId: string;
    adminJwt: string;
    user: (r: RequestBuilder) => RequestBuilder;
    ci: (r: RequestBuilder, token?: string) => RequestBuilder;
    pat: (r: RequestBuilder) => RequestBuilder;
}
interface ICase {
    status: number | number[];
    build: (c: ICtx) => RequestBuilder;
}

/** One case per route, keyed "METHOD /path/:with/:params" exactly as the router reports it. Order matters (status polling revokes CI tokens, so it is last). */
function buildCases(): Record<string, ICase> {
    const screenUpload = (c: ICtx) =>
        c
            .ci(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${c.b2BuildId}/screens`), CI_TOKEN_B2)
            .multiPart([{ name: 'image', file: readFileSync(`${__dirname}/fixtures/finder-1.png`), fileName: 'canary-screen.png' }]);
    return {
        // session (unauthenticated + user)
        'GET /api/session/me': { status: 200, build: c => c.user(HttpRequest.GET('/api/session/me')) },
        'GET /api/session/providers': { status: 200, build: () => HttpRequest.GET('/api/session/providers') },
        'GET /api/session/providers/:id/login-url': {
            status: 200,
            build: () => HttpRequest.GET(`/api/session/providers/${GL_ID}/login-url?redirectUri=http://localhost/cb`)
        },
        'GET /api/session/onboarding-status': { status: 200, build: () => HttpRequest.GET('/api/session/onboarding-status') },
        // error paths only: already onboarded, and the mock GitLab rejects the code
        'POST /api/session/onboarding/vcs-integration': {
            status: 403,
            build: () =>
                HttpRequest.POST('/api/session/onboarding/vcs-integration').json({
                    setupToken: 'nope',
                    integration: { name: 'x', platform: 'gitlab', config: { url: 'http://x', clientId: 'a', clientSecret: 'b' } }
                })
        },
        'POST /api/session/login': {
            status: [400, 401],
            build: () => HttpRequest.POST('/api/session/login').json({ providerId: GL_ID, redirectUri: 'http://localhost/cb', code: 'bad' })
        },

        // admin
        'GET /api/admin/vcs-integrations': { status: 200, build: c => c.user(HttpRequest.GET('/api/admin/vcs-integrations')) },
        'GET /api/admin/vcs-integrations/:id': { status: 200, build: c => c.user(HttpRequest.GET(`/api/admin/vcs-integrations/${GH_ID}`)) },
        'POST /api/admin/vcs-integrations': {
            status: 200,
            build: c =>
                c.user(HttpRequest.POST('/api/admin/vcs-integrations')).json({
                    name: 'Canary new',
                    platform: 'gitlab',
                    config: { url: `http://127.0.0.1:${mockGitLabPort}`, clientId: 'n', clientSecret: CANARY_GITLAB_SECRET }
                })
        },
        'PUT /api/admin/vcs-integrations/:id': {
            status: 200,
            build: c =>
                c
                    .user(HttpRequest.PUT(`/api/admin/vcs-integrations/${GH_ID}`))
                    .json({ name: 'Canary GitHub', platform: 'github', config: { clientSecret: CANARY_GITHUB_SECRET } })
        },
        'DELETE /api/admin/vcs-integrations/:id': {
            status: [200, 204],
            build: c => c.user(HttpRequest.DELETE(`/api/admin/vcs-integrations/${GL_SPARE_ID}`))
        },
        'GET /api/admin/users': { status: 200, build: c => c.user(HttpRequest.GET('/api/admin/users')) },
        'PUT /api/admin/users/:id': {
            status: 200,
            build: c => c.user(HttpRequest.PUT(`/api/admin/users/${OTHER_USER_ID}`)).json({ isAdmin: false })
        },

        // apps
        'GET /api/apps': { status: 200, build: c => c.user(HttpRequest.GET('/api/apps')) },
        'GET /api/apps/:id': { status: 200, build: c => c.user(HttpRequest.GET(`/api/apps/${APP_ID}`)) },
        'POST /api/apps': {
            status: 200,
            build: c =>
                c
                    .user(HttpRequest.POST('/api/apps'))
                    .json({ name: 'Canary created', vcsId: GL_ID, projectPath: 'group/created', vcsProjectId: 77, defaultBranchName: 'main' })
        },
        'PUT /api/apps/:id': { status: 200, build: c => c.user(HttpRequest.PUT(`/api/apps/${APP_ID}`)).json({ name: 'Canary App' }) },
        'DELETE /api/apps/:id': { status: [200, 204], build: c => c.user(HttpRequest.DELETE(`/api/apps/${SPARE_APP_ID}`)) },
        'GET /api/apps/vcs-projects/search': {
            status: 200,
            build: c => c.user(HttpRequest.GET(`/api/apps/vcs-projects/search?vcsId=${GL_ID}&search=canary`))
        },
        'GET /api/apps/vcs-projects/resolve': {
            status: 200,
            build: c =>
                c.user(
                    HttpRequest.GET(
                        `/api/apps/vcs-projects/resolve?vcsId=${GL_ID}&url=${encodeURIComponent(`http://127.0.0.1:${mockGitLabPort}/${PROJECT_PATH}`)}`
                    )
                )
        },
        'GET /api/apps/:appId/branches': { status: 200, build: c => c.user(HttpRequest.GET(`/api/apps/${APP_ID}/branches`)) },

        // builds
        'GET /api/apps/:appId/builds': { status: 200, build: c => c.user(HttpRequest.GET(`/api/apps/${APP_ID}/builds`)) },
        'GET /api/apps/:appId/builds/:id': { status: 200, build: c => c.user(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${c.buildId}`)) },
        // the same commit as the seeded build: returns the EXISTING build row's response
        'POST /api/apps/:appId/builds': { status: 200, build: c => c.ci(HttpRequest.POST(`/api/apps/${APP_ID}/builds`), CI_TOKEN) },
        'GET /api/apps/:appId/builds/:id/screens': {
            status: 200,
            build: c => c.user(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${c.buildId}/screens`))
        },
        'POST /api/apps/:appId/builds/:id/screens': { status: 200, build: screenUpload },
        'GET /api/apps/:appId/builds/:id/screens/:screenId/image': {
            status: 302,
            build: c => c.user(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${c.buildId}/screens/${c.screenId}/image`))
        },
        'GET /api/apps/:appId/builds/:id/screens/:screenId/diff': {
            status: [302, 404],
            build: c => c.user(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${c.buildId}/screens/${c.screenId}/diff`))
        },
        'POST /api/apps/:appId/builds/:id/screens/:screenId/review': {
            status: 200,
            build: c =>
                c
                    .user(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${c.buildId}/screens/${c.screenId}/review`))
                    .json({ reviewStatus: 'approved', comment: 'canary' })
        },
        'POST /api/apps/:appId/builds/:id/process': {
            status: 200,
            build: c => c.ci(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${c.b2BuildId}/process`), CI_TOKEN_B2)
        },
        'POST /api/apps/:appId/builds/:id/approve': {
            status: 200,
            build: c => c.user(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${c.buildId}/approve`))
        },

        // /api/ext (VCS personal access token)
        'GET /api/ext/apps': { status: 200, build: c => c.pat(HttpRequest.GET('/api/ext/apps')) },
        'GET /api/ext/apps/:appId/builds': { status: 200, build: c => c.pat(HttpRequest.GET(`/api/ext/apps/${APP_ID}/builds`)) },
        'GET /api/ext/apps/:appId/builds/:buildId': {
            status: 200,
            build: c => c.pat(HttpRequest.GET(`/api/ext/apps/${APP_ID}/builds/${c.buildId}`))
        },
        'GET /api/ext/apps/:appId/builds/:buildId/screens/:screenId/image': {
            status: 302,
            build: c => c.pat(HttpRequest.GET(`/api/ext/apps/${APP_ID}/builds/${c.buildId}/screens/${c.screenId}/image?kind=new`))
        },

        // last: a final-status poll revokes the polling session's CI token
        'GET /api/apps/:appId/builds/:id/status': {
            status: 200,
            build: c => c.ci(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${c.buildId}/status`), CI_TOKEN)
        }
    };
}

/** Framework-provided routes (health probes, OpenAPI schema, dev console) that carry no application data. */
const EXCLUDED_ROUTES = new Set([
    'GET /healthz',
    'GET /livez',
    'GET /readyz',
    'GET /openapi.yaml',
    'GET /openapi.json',
    'GET /_devconsole',
    'GET /_devconsole/assets/:path'
]);

function scanBody(label: string, body: string, headers: unknown) {
    const haystack = body + JSON.stringify(headers);
    for (const value of FORBIDDEN_VALUES) {
        if (haystack.includes(value)) throw new Error(`${label}: response leaks canary value ${value.slice(0, 16)}...`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return;
    }
    const walk = (node: unknown, path: string) => {
        if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
        if (node && typeof node === 'object') {
            for (const [k, v] of Object.entries(node)) {
                if (FORBIDDEN_KEYS.has(k)) throw new Error(`${label}: response contains forbidden key "${k}" at ${path}.${k}`);
                walk(v, `${path}.${k}`);
            }
        }
    };
    walk(parsed, '$');
}

async function run() {
    await createMockGitLab();

    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, {
        enableDatabase: true,
        databasePrefix: 'pixelci_canarytest'
    });
    await facade.start();

    await seedBase();
    const ctx = await seedBuilds(facade);

    // every route must have a case
    const cases = buildCases();
    const routeKeys = facade.app.router.listRoutes().map(r => `${r.method} ${r.path}`);
    const missing = routeKeys.filter(k => !EXCLUDED_ROUTES.has(k) && !(k in cases));
    if (missing.length) throw new Error(`Routes without a canary case (add a canary case): ${missing.join(', ')}`);
    const stale = Object.keys(cases).filter(k => !routeKeys.includes(k));
    if (stale.length) throw new Error(`Canary cases for routes that no longer exist: ${stale.join(', ')}`);

    for (const [key, c] of Object.entries(cases)) {
        console.log(`\nCanary: ${key}`);
        const response = await facade.request(c.build(ctx));
        const expected = Array.isArray(c.status) ? c.status : [c.status];
        if (!expected.includes(response.statusCode)) {
            throw new Error(`${key}: expected ${expected.join('/')} but got ${response.statusCode}: ${response.bodyString}`);
        }
        scanBody(key, response.bodyString, response.headers);
        console.log(`  PASS (${response.statusCode})`);
    }

    await testNoMassAssignment(facade, ctx);
    mockGitLabServer.close();
}

async function seedBase() {
    await createPersistedEntity(VcsIntegrationEntity, {
        id: GL_ID,
        name: 'Canary GitLab',
        platform: 'gitlab',
        config: { url: `http://127.0.0.1:${mockGitLabPort}`, clientId: 'canary-client', clientSecret: CANARY_GITLAB_SECRET }
    });
    await createPersistedEntity(VcsIntegrationEntity, {
        id: GL_SPARE_ID,
        name: 'Canary spare GitLab',
        platform: 'gitlab',
        config: { url: `http://127.0.0.1:${mockGitLabPort}`, clientId: 'spare-client', clientSecret: CANARY_GITLAB_SECRET }
    });
    await createPersistedEntity(VcsIntegrationEntity, {
        id: GH_ID,
        name: 'Canary GitHub',
        platform: 'github',
        // closed port, so tests never contact real GitHub
        config: {
            url: 'http://127.0.0.1:9',
            clientId: 'gh-client',
            clientSecret: CANARY_GITHUB_SECRET,
            appId: '12345',
            privateKey: GITHUB_PRIVATE_KEY,
            oidcAudience: 'https://pixelci.example.com'
        }
    });

    await createPersistedEntity(UserEntity, {
        id: ADMIN_ID,
        name: 'Canary Admin',
        createdAt: new Date(),
        lastLoginAt: new Date(),
        isAdmin: true,
        vcsId: GL_ID,
        vcsUserId: '4242',
        vcsSession: {
            accessToken: CANARY_ACCESS_TOKEN,
            refreshToken: CANARY_REFRESH_TOKEN,
            expiresAt: Date.now() + 60 * 60 * 1000,
            redirectUri: 'http://localhost'
        }
    });
    await createPersistedEntity(UserEntity, {
        id: OTHER_USER_ID,
        name: 'Canary Other',
        createdAt: new Date(),
        lastLoginAt: new Date(),
        isAdmin: true,
        vcsId: GL_ID,
        vcsUserId: '4343',
        vcsSession: {
            accessToken: CANARY_ACCESS_TOKEN,
            refreshToken: CANARY_REFRESH_TOKEN,
            expiresAt: Date.now() + 60 * 60 * 1000,
            redirectUri: 'http://localhost'
        }
    });

    for (const [id, name, projectPath, vcsProjectId] of [
        [APP_ID, 'Canary App', PROJECT_PATH, 1],
        [SPARE_APP_ID, 'Canary Spare App', 'group/spare', 2]
    ] as const) {
        await createPersistedEntity(AppEntity, {
            id,
            name,
            defaultBranchId: id === APP_ID ? MAIN_BRANCH_ID : null,
            projectPath,
            vcsProjectId,
            vcsId: GL_ID
        });
    }
    await createPersistedEntity(BranchEntity, { id: MAIN_BRANCH_ID, appId: APP_ID, name: 'main' });
}

async function seedBuilds(facade: Facade): Promise<ICtx> {
    const adminJwt = await JWT.generate({ subject: ADMIN_ID });
    const ci = (r: RequestBuilder, token = CI_TOKEN) => r.header('authorization', `Bearer ${token}`);
    const create = async (token: string) => {
        const response = await facade.request(ci(HttpRequest.POST(`/api/apps/${APP_ID}/builds`), token));
        if (response.statusCode !== 200) throw new Error(`seed: create build failed: ${response.statusCode} ${response.bodyString}`);
        scanBody(`seed POST builds (${token === CI_TOKEN ? 'uploader' : 'other'})`, response.bodyString, response.headers);
        return response.json as { id: string };
    };
    const upload = async (buildId: string, token: string, name: string) => {
        const response = await facade.request(
            ci(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${buildId}/screens`), token).multiPart([
                { name: 'image', file: readFileSync(`${__dirname}/fixtures/finder-1.png`), fileName: `${name}.png` }
            ])
        );
        if (response.statusCode !== 200) throw new Error(`seed: upload failed: ${response.statusCode} ${response.bodyString}`);
        scanBody('seed POST screens', response.bodyString, response.headers);
        return response.json as { screenId: string };
    };

    // build 1: created with a CI token, a screen uploaded, processed. Polled through the DB, since the status route revokes CI tokens.
    const build = await create(CI_TOKEN);
    const screen = await upload(build.id, CI_TOKEN, 'canary-screen');
    const processResponse = await facade.request(ci(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${build.id}/process`), CI_TOKEN));
    if (processResponse.statusCode !== 200) throw new Error(`seed: process failed: ${processResponse.statusCode} ${processResponse.bodyString}`);
    await waitForBuild(build.id, s => s !== 'draft' && s !== 'processing');

    // a concurrent job of the same commit gets a read-only token hash on the existing build
    await create(CI_READ_TOKEN);
    const seeded = await BuildEntity.query().filter({ id: build.id }).findOne();
    if (seeded.ciTokenHash !== sha256(CI_TOKEN) || !seeded.ciReadTokenHashes.includes(sha256(CI_READ_TOKEN))) {
        throw new Error('seed: the build does not hold the canary token hashes');
    }
    if (!(await BuildScreenEntity.query().filter({ buildId: build.id }).count())) throw new Error('seed: no build screens');

    // build 2 stays a draft: the upload and process routes run against it
    const b2 = await create(CI_TOKEN_B2);

    return {
        buildId: build.id,
        b2BuildId: b2.id,
        screenId: screen.screenId,
        adminJwt,
        user: r => r.header('authorization', `Bearer ${adminJwt}`),
        ci,
        pat: r => r.header('authorization', `Bearer ${PAT}`).header('x-pixelci-vcs-id', GL_ID)
    };
}

async function waitForBuild(buildId: string, done: (status: BuildEntity['status']) => boolean) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        const b = await BuildEntity.query().filter({ id: buildId }).findOne();
        if (done(b.status)) return;
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('seed: timed out waiting for the build to be processed');
}

/** PUT /api/apps/:id must not let a body overwrite fields outside IAppUpdateInput. */
async function testNoMassAssignment(facade: Facade, ctx: ICtx) {
    console.log('\nTest: PUT /api/apps/:id ignores fields outside the update input');
    const before = await AppEntity.query().filter({ id: APP_ID }).findOne();
    const response = await facade.request(
        ctx.user(HttpRequest.PUT(`/api/apps/${APP_ID}`)).json({ name: 'Canary App', vcsProjectId: 999, deletedAt: '2020-01-01', vcsId: GH_ID })
    );
    scanBody('PUT /api/apps/:id (mass assignment)', response.bodyString, response.headers);
    const after = await AppEntity.query().filter({ id: APP_ID }).findOne();
    if (Number(after.vcsProjectId) !== Number(before.vcsProjectId) || after.deletedAt !== null || after.vcsId !== before.vcsId) {
        throw new Error(
            `mass assignment: app fields were overwritten (status ${response.statusCode}): vcsProjectId=${after.vcsProjectId} deletedAt=${after.deletedAt} vcsId=${after.vcsId}`
        );
    }
    console.log(`  PASS (${response.statusCode})`);
}
