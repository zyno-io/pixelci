/**
 * Approval scenarios: what is approved, rejected and re-asked as builds move between branches and the default branch.
 * Every set is a fresh app and a sequence of builds (see ISetStep); the sets cover the situations a decision-keyed
 * approval model must get right: merges after other merges, loose matches, stale branches, rebases, rejections,
 * revocation, re-added screens, reverts, storage cleanup, concurrency, oversized canvases and the cost bound.
 */
import { HttpRequest } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, JWT, sleepSecs, TestingFacade, TestingHelpers, uuid7 } from '@zyno-io/ts-server-foundation';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { mock } from 'node:test';
import { PNG } from 'pngjs/browser';

import type { IBuildScreenCompareResponse, IBuildScreenResponse } from '../../src/controllers/BuildScreens.controller';

import { CoreAppOptions } from '../../src/app';
import { Db } from '../../src/database';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { BuildEntity } from '../../src/entities/Build.entity';
import { BuildScreenEntity } from '../../src/entities/BuildScreen.entity';
import { ScreenEntity } from '../../src/entities/Screen.entity';
import { ScreenDecisionEntity } from '../../src/entities/ScreenDecision.entity';
import { UserEntity } from '../../src/entities/User.entity';
import { VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { backfillLegacyReferences } from '../../src/migrations/20261117_120000_screen_decisions';
import { PixelMatchService } from '../../src/services/PixelMatch.service';
import { S3Service } from '../../src/services/S3.service';
import { sealIntegrationConfig, sealVcsSession } from '../../src/services/secrets/VcsSecrets';
import { createGcContext, StorageGcService } from '../../src/services/storage/StorageGc.service';
import { configureTestDatabase, ensureTestBucket, useIsolatedRedisPrefix } from './db-defaults';

process.env.CI = 'true';
useIsolatedRedisPrefix('approvals');
configureTestDatabase();

const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const PROJECT_PATH = 'group/approval-scenarios';
// fixtures: A -> B -> C are three versions of one screen; X is another screen
const A = 'finder-1.png';
const B = 'finder-1-changed.png';
const C = 'finder-1-changed-2.png';
const X = 'finder-2.png';

type Fixture = string | Buffer;
type BuildStatus = BuildEntity['status'];
const FINAL_STATUSES: BuildStatus[] = ['no changes', 'needs review', 'changes approved', 'changes rejected'];
type Verdict = 'approved' | 'rejected';

interface IExpect {
    /** The build's status once processed ('any-final': any status after processing; the build is not required to need review). */
    build: BuildStatus | 'any-final';
    /** Per uploaded screen name: its status, or [status, review pre-mark]. Screens not listed are not checked. */
    screens?: Record<string, string | [string, string]>;
    /** Per removed screen name (tombstone): its status. */
    removed?: Record<string, string>;
    /** The reference build (a step label, or null for none) and how it was found. */
    reference?: { step: string | null; source: string };
    /** Per screen name (uploaded or removed): the step whose build recorded the decision behind this row's outcome. */
    decisionFrom?: Record<string, string>;
    /** The build's status after submit (approve); defaults to 'changes approved'. */
    afterSubmit?: BuildStatus;
}

interface ISetStep {
    label: string;
    branch: string;
    /** Commit labels, nearest first (a default-branch build lists itself first, like `git rev-list --first-parent HEAD`); null: the CLI sent no base. */
    base: string[] | null;
    screens: Record<string, Fixture>;
    /** Per-screen reviews made before submitting. */
    review?: Record<string, Verdict>;
    /** Approve the build (submit the review) once it has been checked. */
    submit?: boolean;
    expect: IExpect;
    then?: (result: IStepResult) => Promise<void>;
}

interface IStepResult {
    label: string;
    buildId: string;
    status: BuildStatus;
    /** Rows as processed (before any review), by screen name; tombstones are keyed by name too. */
    rows: Record<string, BuildScreenEntity>;
    screenIds: Record<string, string>;
}

let mockServer: Server;
let mockPort: number;
const jobs = new Map<string, { id: number; ref: string; sha: string }>();
let jobSeq = 0;

run()
    .then(() => {
        console.log('\nAll approval scenario tests passed!');
        process.exit(0);
    })
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

function startMock(): Promise<void> {
    return new Promise(resolve => {
        mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
            const json = (body: unknown) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
            };
            if (req.url === '/api/v4/job') {
                const job = jobs.get(req.headers['job-token'] as string);
                if (!job) {
                    res.writeHead(401);
                    return res.end('Unauthorized');
                }
                return json({
                    id: job.id,
                    ref: job.ref,
                    pipeline: { project_id: 1, sha: job.sha },
                    commit: { title: `commit ${job.id}`, author_name: 'int-test' }
                });
            }
            if (req.method === 'POST' && /\/jobs\/[^/]+\/retry$/.test(req.url ?? '')) return json({ id: 999, pipeline: { id: 7 } });
            if (req.url?.startsWith('/api/v4/projects/')) return json({ id: 1, path_with_namespace: PROJECT_PATH });
            res.writeHead(404);
            res.end('Not found');
        });
        mockServer.listen(0, () => {
            mockPort = (mockServer.address() as { port: number }).port;
            resolve();
        });
    });
}

function assertEq(actual: unknown, expected: unknown, msg: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}
function assertTrue(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}

const fixtureCache = new Map<string, Buffer>();
const fixtureBytes = (f: Fixture) => {
    if (typeof f !== 'string') return f;
    if (!fixtureCache.has(f)) fixtureCache.set(f, readFileSync(`${__dirname}/fixtures/${f}`));
    return fixtureCache.get(f)!;
};
const solid = (w: number, h: number, rgb: [number, number, number]) => {
    const png = new PNG({ width: w, height: h });
    for (let i = 0; i < w * h; i++) {
        png.data[i * 4] = rgb[0];
        png.data[i * 4 + 1] = rgb[1];
        png.data[i * 4 + 2] = rgb[2];
        png.data[i * 4 + 3] = 255;
    }
    return Buffer.from(PNG.sync.write(png));
};

class Harness {
    readonly appId = uuid7();
    readonly mainBranchId = uuid7();
    readonly results = new Map<string, IStepResult>();

    constructor(
        readonly facade: TestingFacade,
        readonly set: string,
        readonly jwt: string
    ) {}

    static async create(facade: TestingFacade, set: string, jwt: string) {
        const h = new Harness(facade, set, jwt);
        await createPersistedEntity(AppEntity, {
            id: h.appId,
            name: `Approvals ${set}`,
            defaultBranchId: h.mainBranchId,
            projectPath: PROJECT_PATH,
            vcsProjectId: 1,
            vcsId: ZERO_ID
        });
        await createPersistedEntity(BranchEntity, { id: h.mainBranchId, appId: h.appId, name: 'main' });
        return h;
    }

    commitFor = (label: string) => createHash('sha1').update(`${this.set}:${label}`).digest('hex');
    user = (r: HttpRequest) => r.header('authorization', `Bearer ${this.jwt}`);
    s3 = () => this.facade.get<S3Service>(S3Service);

    async call<T>(req: HttpRequest, expectedStatus = 200): Promise<T> {
        const res = await this.facade.request(req);
        if (res.statusCode !== expectedStatus) throw new Error(`[${this.set}] expected ${expectedStatus} but got ${res.statusCode}: ${res.body}`);
        return (expectedStatus === 200 ? res.json : undefined) as T;
    }

    async rowsOf(buildId: string) {
        const rows = await BuildScreenEntity.query().filter({ buildId }).find();
        const screens = await ScreenEntity.query()
            .filter({ id: { $in: rows.map(r => r.screenId) } })
            .find();
        const names = Object.fromEntries(screens.map(s => [s.id, s.name]));
        return Object.fromEntries(rows.map(r => [names[r.screenId], r])) as Record<string, BuildScreenEntity>;
    }

    async decisionOf(row: BuildScreenEntity) {
        return row.decisionId ? ScreenDecisionEntity.query().filter({ id: row.decisionId }).findOne() : undefined;
    }

    getScreens(buildId: string) {
        return this.call<IBuildScreenResponse[]>(this.user(HttpRequest.GET(`/api/apps/${this.appId}/builds/${buildId}/screens`)));
    }

    /** Approves the build; returns the HTTP status (so a test can race two approvals). */
    async submit(buildId: string): Promise<number> {
        const res = await this.facade.request(this.user(HttpRequest.POST(`/api/apps/${this.appId}/builds/${buildId}/approve`)));
        return res.statusCode;
    }

    async revoke(decisionId: string) {
        return this.call<{ id: string; revokedAt: string | null; revokedByName: string | null }>(
            this.user(HttpRequest.POST(`/api/apps/${this.appId}/decisions/${decisionId}/revoke`))
        );
    }

    /** Creates the build, uploads the screens, processes it, waits for the result and checks it. */
    async run(step: ISetStep): Promise<IStepResult> {
        const where = `${this.set}/${step.label}`;
        console.log(`  ${step.label}: ${step.branch} [${Object.keys(step.screens).join(', ') || 'no screens'}]`);

        const token = `tok-${this.set}-${step.label}-${++jobSeq}`;
        jobs.set(token, { id: jobSeq, ref: step.branch, sha: this.commitFor(step.label) });
        const ci = (r: HttpRequest) => r.header('authorization', `Bearer ${token}`);

        const build = await this.call<{ id: string }>(ci(HttpRequest.POST(`/api/apps/${this.appId}/builds`)));
        for (const [name, fixture] of Object.entries(step.screens)) {
            await this.call(
                ci(HttpRequest.POST(`/api/apps/${this.appId}/builds/${build.id}/screens`)).multiPart([
                    { name: 'image', file: fixtureBytes(fixture), fileName: `${name}.png` }
                ])
            );
        }
        await this.call(
            ci(HttpRequest.POST(`/api/apps/${this.appId}/builds/${build.id}/process`)).json(
                step.base ? { base: { commits: step.base.map(this.commitFor), source: 'merge-base' } } : {}
            )
        );
        let status: BuildStatus = 'processing';
        for (let i = 0; i < 200 && status === 'processing'; i++) {
            await sleepSecs(0.3);
            status = (await BuildEntity.query().filter({ id: build.id }).findOne()).status;
        }

        const rows = await this.rowsOf(build.id);
        const result: IStepResult = {
            label: step.label,
            buildId: build.id,
            status,
            rows,
            screenIds: Object.fromEntries(Object.entries(rows).map(([name, r]) => [name, r.screenId]))
        };
        this.results.set(step.label, result);

        await this.check(where, step, result);

        if (step.review) {
            for (const [name, verdict] of Object.entries(step.review)) {
                await this.call(
                    this.user(HttpRequest.POST(`/api/apps/${this.appId}/builds/${build.id}/screens/${result.screenIds[name]}/review`)).json({
                        reviewStatus: verdict,
                        comment: `${verdict} in ${step.label}`
                    })
                );
            }
        }
        if (step.submit) {
            assertEq(status, 'needs review', `${where}: only a build that needs review can be submitted`);
            assertEq(await this.submit(build.id), 200, `${where}: submit`);
            assertEq(
                (await BuildEntity.query().filter({ id: build.id }).findOne()).status,
                step.expect.afterSubmit ?? 'changes approved',
                `${where}: status after submit`
            );
        }
        await step.then?.(result);
        return result;
    }

    /**
     * Every S3 object this app's data still points at: what each row displays, each reference's baseline sources, each row's
     * baseImageBuildId (tombstones included) and the from/to image of every decision (revoked ones too), plus the stored diffs.
     */
    async referencedObjects(): Promise<Map<string, string>> {
        const s3 = this.s3();
        const required = new Map<string, string>();
        const need = (buildId: string | null, screenId: string, why: string) => {
            if (buildId) required.set(s3.getPathForScreen(this.appId, buildId, screenId), why);
        };
        const builds = await BuildEntity.query().filter({ appId: this.appId }).find();
        const rows = await BuildScreenEntity.query().filter({ appId: this.appId }).find();
        const decisions = await ScreenDecisionEntity.query().filter({ appId: this.appId }).find();
        const rowsByBuild = new Map<string, BuildScreenEntity[]>();
        for (const row of rows) rowsByBuild.set(row.buildId, [...(rowsByBuild.get(row.buildId) ?? []), row]);

        for (const row of rows) {
            // what the UI and the external API show for the row
            if (!row.isRemoved && row.status !== null)
                need(row.status === 'no changes' ? (row.matchedBuildId ?? row.buildId) : row.buildId, row.screenId, 'display image');
            need(row.baseImageBuildId, row.screenId, 'baseImageBuildId');
        }
        for (const build of builds) {
            for (const ref of rowsByBuild.get(build.referenceBuildId ?? '') ?? []) {
                if (!ref.isRemoved) need(ref.matchedBuildId ?? ref.buildId, ref.screenId, 'reference source');
            }
        }
        for (const d of decisions) {
            need(d.fromImageBuildId, d.screenId, 'decision from');
            need(d.toImageBuildId, d.screenId, 'decision to');
        }
        for (const row of rows) {
            if (!row.isRemoved && row.status !== null && row.status !== 'no changes' && row.baseImageBuildId) {
                required.set(s3.getPathForDiff(this.appId, row.buildId, row.screenId), 'diff');
            }
        }
        return required;
    }

    /**
     * The storage cleaner's safety test: sweeps the whole app (delete mode, no grace period) and checks that every object the data
     * still points at, and that existed before, survived. Then processes one more build to prove baselines are still usable.
     */
    async sweepAndVerify(): Promise<{ deleted: number; checked: number }> {
        const s3 = this.s3();
        const where = `${this.set}/sweep`;
        const before = await this.referencedObjects();
        const existed: [string, string][] = [];
        for (const [key, why] of before) if (await s3.exists(key)) existed.push([key, why]);

        const gc = this.facade.get<StorageGcService>(StorageGcService);
        const ctx = createGcContext(gc.getSettings(), { mode: 'delete', graceMs: 0, now: new Date(Date.now() + 120_000), deadlineAt: Infinity });
        assertTrue(await gc.sweepApp(this.appId, ctx), `${where}: the sweep reached the end of the app`);
        assertEq(ctx.stats.deleteErrors, 0, `${where}: no delete errors`);
        assertEq(ctx.stats.unknownBuild, 0, `${where}: every object belongs to a known build`);

        for (const [key, why] of existed) assertTrue(await s3.exists(key), `${where}: ${why} survived the sweep: ${key}`);
        console.log(`  sweep: deleted ${ctx.stats.deleted.count}, kept ${ctx.stats.skippedLive} (${existed.length} referenced objects verified)`);

        // processing still works against whatever the sweep left
        await this.run({ label: 'Zsweep', branch: 'post-sweep', base: null, screens: { 'after-sweep': A }, expect: { build: 'any-final' } });
        for (const [key, why] of await this.referencedObjects()) {
            if (before.has(key) && !existed.some(([k]) => k === key)) continue; // missing before the sweep: not the sweep's doing
            assertTrue(await s3.exists(key), `${where}: ${why} exists after processing a build: ${key}`);
        }
        return { deleted: ctx.stats.deleted.count, checked: existed.length };
    }

    private async check(where: string, step: ISetStep, result: IStepResult) {
        const { expect } = step;
        if (expect.build === 'any-final') {
            assertTrue(FINAL_STATUSES.includes(result.status), `${where}: build finished processing (got ${result.status})`);
        } else {
            assertEq(result.status, expect.build, `${where}: build status`);
        }
        for (const [name, want] of Object.entries(expect.screens ?? {})) {
            const row = result.rows[name];
            assertTrue(row && !row.isRemoved, `${where}: expected an uploaded row for ${name}`);
            const [status, premark] = Array.isArray(want) ? want : [want, null];
            assertEq([row.status, row.reviewStatus], [status, premark], `${where}: ${name} [status, pre-mark]`);
            if (row.reviewStatus && !row.reviewedById) assertEq(row.reviewedAt, null, `${where}: ${name} pre-mark has no review time`);
        }
        for (const [name, status] of Object.entries(expect.removed ?? {})) {
            const row = result.rows[name];
            assertTrue(row?.isRemoved, `${where}: expected a tombstone for ${name}`);
            assertEq(row.status, status, `${where}: removed ${name}`);
        }
        if (expect.reference) {
            const b = await BuildEntity.query().filter({ id: result.buildId }).findOne();
            const refId = expect.reference.step ? this.results.get(expect.reference.step)!.buildId : null;
            assertEq([b.referenceBuildId, b.referenceSource], [refId, expect.reference.source], `${where}: reference`);
        }
        for (const [name, from] of Object.entries(expect.decisionFrom ?? {})) {
            const decision = await this.decisionOf(result.rows[name]);
            assertTrue(decision, `${where}: ${name} has a decision`);
            assertEq(decision.buildId, this.results.get(from)!.buildId, `${where}: ${name} decision comes from ${from}`);
        }

        // invariant: a changed row that was compared with a baseline has its own diff, and keeps its own upload
        for (const [name, row] of Object.entries(result.rows)) {
            if (row.isRemoved || !row.baseImageBuildId || row.status === 'no changes') continue;
            assertTrue(
                await this.s3().exists(this.s3().getPathForDiff(this.appId, row.buildId, row.screenId)),
                `${where}: ${name} has a diff at its own path`
            );
            assertTrue(
                await this.s3().exists(this.s3().getPathForScreen(this.appId, row.buildId, row.screenId)),
                `${where}: ${name} keeps its own image`
            );
            assertEq(row.storageStatus, 'stored', `${where}: ${name} storage`);
        }
        for (const [name, row] of Object.entries(result.rows)) {
            if (row.status === 'no changes')
                assertEq(row.storageStatus, 'pendingDeletion', `${where}: ${name} unchanged rows hold nothing of their own`);
        }
    }
}

async function run() {
    await startMock();
    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, {
        enableDatabase: true,
        databasePrefix: 'pixelci_approvalstest',
        // Real, independent connections/transactions are required to exercise concurrency (savepoint mode serializes on one)
        useSavepoints: false
    });
    await ensureTestBucket();
    await facade.start();

    await createPersistedEntity(UserEntity, {
        id: ZERO_ID,
        name: 'Approvals Test User',
        createdAt: new Date(),
        lastLoginAt: new Date(),
        isAdmin: true,
        vcsId: ZERO_ID,
        vcsUserId: ZERO_ID,
        vcsSession: sealVcsSession({ accessToken: 'a', expiresAt: Date.now() + 3600_000, refreshToken: 'r', redirectUri: 'http://localhost' })
    });
    await createPersistedEntity(VcsIntegrationEntity, {
        id: ZERO_ID,
        name: 'Approvals Test VCS',
        platform: 'gitlab',
        config: sealIntegrationConfig({ url: `http://127.0.0.1:${mockPort}`, clientId: 'c', clientSecret: 's' })
    });
    const jwt = await JWT.generate({ subject: ZERO_ID });

    const only = process.env.SET;
    let totalDeleted = 0;
    let totalChecked = 0;
    for (const [name, fn] of Object.entries(SETS)) {
        if (only && only !== name) continue;
        console.log(`\nSet: ${name}`);
        const h = await Harness.create(facade, name, jwt);
        await fn(h, facade);
        const swept = await h.sweepAndVerify();
        totalDeleted += swept.deleted;
        totalChecked += swept.checked;
        console.log('  PASS');
    }
    if (!only) {
        assertTrue(totalChecked > 0, 'the sweep checks run against real referenced objects');
        assertTrue(totalDeleted > 0, 'the sweeps deleted garbage somewhere (so the checks above were not vacuous)');
    }

    mockServer.close();
}

/** A baseline build on main: every screen new, then approved. */
const baseline = (screens: Record<string, Fixture>, label = 'M0'): ISetStep => ({
    label,
    branch: 'main',
    base: [label],
    screens,
    submit: true,
    expect: { build: 'needs review', screens: Object.fromEntries(Object.keys(screens).map(n => [n, 'new'])) }
});

type SetFn = (h: Harness, facade: TestingFacade) => Promise<void>;

const SETS: Record<string, SetFn> = {
    // #1: a branch's approved change is not asked again on main after another merge landed first
    async merge(h) {
        await h.run(baseline({ s1: A }));
        await h.run({
            label: 'F1',
            branch: 'feat-f',
            base: ['M0'],
            screens: { s1: B },
            submit: true,
            expect: { build: 'needs review', screens: { s1: 'needs review' } }
        });
        await h.run({
            label: 'G1',
            branch: 'feat-g',
            base: ['M0'],
            screens: { s1: A, s2: X },
            submit: true,
            expect: { build: 'needs review', screens: { s1: 'no changes', s2: 'new' } }
        });
        await h.run({
            label: 'M1',
            branch: 'main',
            base: ['M1', 'M0'],
            screens: { s1: A, s2: X },
            expect: {
                build: 'changes approved',
                screens: { s1: 'no changes', s2: 'changes approved' },
                reference: { step: 'M0', source: 'ancestor' },
                decisionFrom: { s2: 'G1' }
            }
        });
        await h.run({
            label: 'M2',
            branch: 'main',
            base: ['M2', 'M1', 'M0'],
            screens: { s1: B, s2: X },
            expect: {
                build: 'changes approved',
                screens: { s1: 'changes approved', s2: 'no changes' },
                reference: { step: 'M1', source: 'ancestor' },
                decisionFrom: { s1: 'F1' }
            }
        });
    },

    // #1: the same for a removal
    async mergeRemoval(h) {
        await h.run(baseline({ s1: A, s2: X }));
        await h.run({
            label: 'F1',
            branch: 'feat-f',
            base: ['M0'],
            screens: { s1: A },
            submit: true,
            expect: { build: 'needs review', removed: { s2: 'needs review' } }
        });
        await h.run({
            label: 'G1',
            branch: 'feat-g',
            base: ['M0'],
            screens: { s1: B, s2: X },
            submit: true,
            expect: { build: 'needs review', screens: { s1: 'needs review', s2: 'no changes' } }
        });
        await h.run({
            label: 'M1',
            branch: 'main',
            base: ['M1', 'M0'],
            screens: { s1: B, s2: X },
            expect: { build: 'changes approved', screens: { s1: 'changes approved', s2: 'no changes' }, decisionFrom: { s1: 'G1' } }
        });
        const m2 = await h.run({
            label: 'M2',
            branch: 'main',
            base: ['M2', 'M1', 'M0'],
            screens: { s1: B },
            expect: {
                build: 'changes approved',
                screens: { s1: 'no changes' },
                removed: { s2: 'changes approved' },
                decisionFrom: { s2: 'F1' }
            }
        });
        // provenance for the review page
        const screens = await h.getScreens(m2.buildId);
        const s2 = screens.find(s => s.name === 's2')!;
        assertEq(
            [s2.removedBuildScreen?.decision?.kind, s2.removedBuildScreen?.decision?.buildId],
            ['approved', h.results.get('F1')!.buildId],
            'removal provenance'
        );
    },

    // #2: B and C were each approved against A; B -> C was never approved
    async loose(h) {
        await h.run(baseline({ s1: A }));
        await h.run({ label: 'F1', branch: 'feat-f', base: ['M0'], screens: { s1: B }, submit: true, expect: { build: 'needs review' } });
        await h.run({ label: 'G1', branch: 'feat-g', base: ['M0'], screens: { s1: C }, submit: true, expect: { build: 'needs review' } });
        await h.run({
            label: 'M1',
            branch: 'main',
            base: ['M1', 'M0'],
            screens: { s1: B },
            expect: { build: 'changes approved', screens: { s1: 'changes approved' }, decisionFrom: { s1: 'F1' } }
        });
        await h.run({
            label: 'H1',
            branch: 'feat-h',
            base: ['M1', 'M0'],
            screens: { s1: C },
            expect: { build: 'needs review', screens: { s1: 'needs review' } }
        });
    },

    // #3: the diff is the one against the build's own baseline
    async diff(h) {
        const m0 = await h.run(baseline({ s1: A }));
        await h.run({ label: 'F1', branch: 'feat-f', base: ['M0'], screens: { s1: B }, submit: true, expect: { build: 'needs review' } });
        const g1 = await h.run({
            label: 'G1',
            branch: 'feat-g',
            base: ['M0'],
            screens: { s1: C },
            expect: { build: 'needs review', screens: { s1: 'needs review' }, reference: { step: 'M0', source: 'ancestor' } }
        });
        // (the diff existing at G1's own path is asserted for every row by the harness)
        const screens = await h.getScreens(g1.buildId);
        assertEq(screens[0].referenceBuildScreen?.buildId, m0.buildId, 'getScreens reference is M0');
        const preview = await h.call<IBuildScreenCompareResponse>(
            h.user(HttpRequest.POST(`/api/apps/${h.appId}/builds/${g1.buildId}/screens/${g1.screenIds.s1}/compare`)).json({
                colorTolerance: 0.2,
                shiftTolerance: 1,
                diffPctTolerance: 0.01,
                masks: []
            })
        );
        assertEq(preview.passes, false, 'compare against M0 does not pass');
    },

    // #4: a branch cut before main moved is compared with where it forked
    async staleBase(h) {
        await h.run(baseline({ s1: A }));
        await h.run({ label: 'M1', branch: 'main', base: ['M1', 'M0'], screens: { s1: C }, submit: true, expect: { build: 'needs review' } });
        await h.run({
            label: 'X1',
            branch: 'feat-x',
            base: ['M0'],
            screens: { s1: A },
            expect: { build: 'no changes', screens: { s1: 'no changes' }, reference: { step: 'M0', source: 'ancestor' } }
        });
        await h.run({
            label: 'Y1',
            branch: 'feat-y',
            base: ['M1', 'M0'],
            screens: { s1: A },
            expect: { build: 'needs review', screens: { s1: 'needs review' }, reference: { step: 'M1', source: 'ancestor' } }
        });
    },

    // no base from the CLI: the latest accepted main build, and approvals made against that guess stay on their own branch
    async staleFallback(h) {
        await h.run(baseline({ s1: A }));
        await h.run({ label: 'M1', branch: 'main', base: ['M1', 'M0'], screens: { s1: C }, submit: true, expect: { build: 'needs review' } });
        const x1 = await h.run({
            label: 'X1',
            branch: 'feat-x',
            base: null,
            screens: { s1: A },
            submit: true,
            expect: { build: 'needs review', screens: { s1: 'needs review' }, reference: { step: 'M1', source: 'latest' } }
        });
        const decision = await h.decisionOf((await h.rowsOf(x1.buildId)).s1);
        assertEq(decision?.branchScoped, true, 'approval against a fallback baseline is branch-scoped');
        await h.run({
            label: 'Y1',
            branch: 'feat-y',
            base: null,
            screens: { s1: A },
            expect: { build: 'needs review', screens: { s1: 'needs review' } }
        });
        await h.run({
            label: 'X2',
            branch: 'feat-x',
            base: null,
            screens: { s1: A },
            expect: { build: 'changes approved', screens: { s1: 'changes approved' }, decisionFrom: { s1: 'X1' } }
        });
    },

    // #5: a rebase that drops main's newer change doesn't inherit the branch's old approval
    async rebase(h) {
        await h.run(baseline({ s1: A }));
        await h.run({ label: 'F1', branch: 'feat-f', base: ['M0'], screens: { s1: B }, submit: true, expect: { build: 'needs review' } });
        await h.run({ label: 'M1', branch: 'main', base: ['M1', 'M0'], screens: { s1: C }, submit: true, expect: { build: 'needs review' } });
        await h.run({
            label: 'F2',
            branch: 'feat-f',
            base: ['M1', 'M0'],
            screens: { s1: B },
            expect: { build: 'needs review', screens: { s1: 'needs review' } }
        });
    },

    // #6: a rejection sticks: the same change arrives pre-marked, wherever it is made
    async reject(h) {
        await h.run(baseline({ s1: A }));
        await h.run({
            label: 'R1',
            branch: 'feat-r',
            base: ['M0'],
            screens: { s1: B },
            review: { s1: 'rejected' },
            submit: true,
            expect: { build: 'needs review', screens: { s1: 'needs review' }, afterSubmit: 'changes rejected' }
        });
        const f1 = await h.run({
            label: 'F1',
            branch: 'feat-f',
            base: ['M0'],
            screens: { s1: B },
            submit: true,
            expect: {
                build: 'needs review',
                screens: { s1: ['needs review', 'rejected'] },
                decisionFrom: { s1: 'R1' },
                afterSubmit: 'changes rejected'
            }
        });
        assertEq(f1.rows.s1.reviewedById, null, 'a pre-marked rejection has no reviewer');
        await h.run({
            label: 'R2',
            branch: 'feat-r',
            base: ['M0'],
            screens: { s1: B },
            expect: { build: 'needs review', screens: { s1: ['needs review', 'rejected'] }, decisionFrom: { s1: 'F1' } }
        });
    },

    // #6, product call 1: a reviewer who flips the pre-marked rejection to an approval overrides it
    async reject2(h) {
        await h.run(baseline({ s1: A }));
        await h.run({
            label: 'R1',
            branch: 'feat-r',
            base: ['M0'],
            screens: { s1: B },
            review: { s1: 'rejected' },
            submit: true,
            expect: { build: 'needs review', afterSubmit: 'changes rejected' }
        });
        await h.run({
            label: 'F1',
            branch: 'feat-f',
            base: ['M0'],
            screens: { s1: B },
            review: { s1: 'approved' },
            submit: true,
            expect: { build: 'needs review', screens: { s1: ['needs review', 'rejected'] } }
        });
        await h.run({
            label: 'R2',
            branch: 'feat-r',
            base: ['M0'],
            screens: { s1: B },
            expect: { build: 'changes approved', screens: { s1: 'changes approved' }, decisionFrom: { s1: 'F1' } }
        });
    },

    // #6: revoking an approval means the next build asks again; revoking a rejection unblocks an older approval
    async revoke(h) {
        await h.run(baseline({ s1: A }));
        const f1 = await h.run({ label: 'F1', branch: 'feat-f', base: ['M0'], screens: { s1: B }, submit: true, expect: { build: 'needs review' } });
        const f1Decision = (await h.decisionOf((await h.rowsOf(f1.buildId)).s1))!;
        await h.run({
            label: 'G1',
            branch: 'feat-g',
            base: ['M0'],
            screens: { s1: B },
            expect: { build: 'changes approved', screens: { s1: 'changes approved' }, decisionFrom: { s1: 'F1' } }
        });

        const revoked = await h.revoke(f1Decision.id);
        assertTrue(revoked.revokedAt && revoked.revokedByName === 'Approvals Test User', 'revoke attributes the user');
        // idempotent: the second revoke returns 200 with the first revocation
        const again = await h.revoke(f1Decision.id);
        assertEq(again.revokedAt, revoked.revokedAt, 'revoking twice keeps the first revocation');
        // builds already approved stay approved
        assertEq(
            (
                await BuildEntity.query()
                    .filter({ id: h.results.get('G1')!.buildId })
                    .findOne()
            ).status,
            'changes approved',
            'G1 stays approved'
        );
        await h.run({
            label: 'G2',
            branch: 'feat-g',
            base: ['M0'],
            screens: { s1: B },
            expect: { build: 'needs review', screens: { s1: 'needs review' } }
        });
        // an unknown decision is a 404
        await h.call(h.user(HttpRequest.POST(`/api/apps/${h.appId}/decisions/${uuid7()}/revoke`)), 404);
    },

    // revoking a rejection unblocks an approval that is older than it
    async revokeRejection(h) {
        await h.run(baseline({ s1: A }));
        // an approval made against a guessed baseline: reusable on feat-f only
        await h.run({
            label: 'F1',
            branch: 'feat-f',
            base: null,
            screens: { s1: B },
            submit: true,
            expect: { build: 'needs review', reference: { step: 'M0', source: 'latest' } }
        });
        // on another branch that approval doesn't apply, so the change can be rejected there (globally: it has a real base)
        const r1 = await h.run({
            label: 'R1',
            branch: 'feat-r',
            base: ['M0'],
            screens: { s1: B },
            review: { s1: 'rejected' },
            submit: true,
            expect: { build: 'needs review', screens: { s1: 'needs review' }, afterSubmit: 'changes rejected' }
        });
        // back on feat-f the newer rejection wins over the older approval
        await h.run({
            label: 'F2',
            branch: 'feat-f',
            base: null,
            screens: { s1: B },
            expect: { build: 'needs review', screens: { s1: ['needs review', 'rejected'] }, decisionFrom: { s1: 'R1' } }
        });
        const rejection = (await h.decisionOf((await h.rowsOf(r1.buildId)).s1))!;
        assertEq(rejection.kind, 'rejected', 'R1 recorded a rejection');
        await h.revoke(rejection.id);
        await h.run({
            label: 'F3',
            branch: 'feat-f',
            base: null,
            screens: { s1: B },
            expect: { build: 'changes approved', screens: { s1: 'changes approved' }, decisionFrom: { s1: 'F1' } }
        });
    },

    // #6: auto-approved rows and carried marks are not attributed to anyone; the submitter takes them on
    async audit(h) {
        await h.run(baseline({ s1: A, s2: X }));
        await h.run({ label: 'F1', branch: 'feat-f', base: ['M0'], screens: { s1: B, s2: X }, submit: true, expect: { build: 'needs review' } });
        const g1 = await h.run({
            label: 'G1',
            branch: 'feat-g',
            base: ['M0'],
            screens: { s1: B, s2: X },
            expect: { build: 'changes approved', screens: { s1: 'changes approved' }, decisionFrom: { s1: 'F1' } }
        });
        assertEq([g1.rows.s1.reviewedById, g1.rows.s1.approvalBuildId], [null, h.results.get('F1')!.buildId], 'auto-approved row has no reviewer');
        assertEq((await h.decisionOf(g1.rows.s1))?.decidedById, ZERO_ID, 'the decision names the original reviewer');
        const g1Screens = await h.getScreens(g1.buildId);
        const g1s1 = g1Screens.find(s => s.name === 's1')!.currentBuildScreen!;
        assertEq(
            [g1s1.decision?.kind, g1s1.decision?.buildId, g1s1.decision?.decidedByName],
            ['approved', h.results.get('F1')!.buildId, 'Approvals Test User'],
            'provenance on getScreens'
        );

        // a mark made on a branch's previous build carries over to an identical change, with no reviewer
        const p1 = await h.run({
            label: 'P1',
            branch: 'feat-p',
            base: ['M0'],
            screens: { s1: C, s2: X },
            review: { s1: 'approved' },
            expect: { build: 'needs review', screens: { s1: 'needs review' } }
        });
        await h.run({
            label: 'P2',
            branch: 'feat-p',
            base: ['M0'],
            screens: { s1: C, s2: X },
            expect: { build: 'needs review', screens: { s1: ['needs review', 'approved'] } },
            then: async p2 => {
                assertEq([p2.rows.s1.reviewedById, p2.rows.s1.reviewedAt], [null, null], 'carried mark has no reviewer');
                const p1Row = (await h.rowsOf(p1.buildId)).s1;
                assertEq(p2.rows.s1.reviewCarriedFromId, p1Row.id, 'carried mark points at the review it came from');
                const screens = await h.getScreens(p2.buildId);
                const carried = screens.find(s => s.name === 's1')!.currentBuildScreen!.reviewCarriedFrom;
                assertEq([carried?.buildId, carried?.reviewedByName], [p1.buildId, 'Approvals Test User'], 'carried provenance on getScreens');

                assertEq(await h.submit(p2.buildId), 200, 'P2 submit');
                const row = (await h.rowsOf(p2.buildId)).s1;
                assertEq(row.reviewedById, ZERO_ID, 'the submitter takes the carried mark');
                assertEq((await h.decisionOf(row))?.decidedById, ZERO_ID, 'and is the decider');
            }
        });
    },

    // #7: a screen removed on main and added back with its old image is new, not auto-approved from the old approval
    async readd(h) {
        await h.run(baseline({ s1: A, s2: X }));
        await h.run({
            label: 'M1',
            branch: 'main',
            base: ['M1', 'M0'],
            screens: { s1: A },
            submit: true,
            expect: { build: 'needs review', removed: { s2: 'needs review' } }
        });
        await h.run({ label: 'M2', branch: 'main', base: ['M2', 'M1', 'M0'], screens: { s1: B }, submit: true, expect: { build: 'needs review' } });
        await h.run({
            label: 'F1',
            branch: 'feat-f',
            base: ['M2', 'M1', 'M0'],
            screens: { s1: B, s2: X },
            expect: { build: 'needs review', screens: { s1: 'no changes', s2: 'new' } }
        });
    },

    // A -> B merged, B -> A merged: B again is a new change, even though A -> B was once approved
    async revert(h) {
        await h.run(baseline({ s1: A }));
        await h.run({ label: 'M1', branch: 'main', base: ['M1', 'M0'], screens: { s1: B }, submit: true, expect: { build: 'needs review' } });
        await h.run({ label: 'M2', branch: 'main', base: ['M2', 'M1', 'M0'], screens: { s1: A }, submit: true, expect: { build: 'needs review' } });
        await h.run({
            label: 'H1',
            branch: 'feat-h',
            base: ['M2', 'M1', 'M0'],
            screens: { s1: B },
            expect: { build: 'needs review', screens: { s1: 'needs review' }, reference: { step: 'M2', source: 'ancestor' } }
        });
    },

    // a screen added on one branch is approved wherever it is added, including on main after the merge
    async newScreenCrossBranch(h) {
        await h.run(baseline({ s1: A }));
        await h.run({
            label: 'F1',
            branch: 'feat-f',
            base: ['M0'],
            screens: { s1: A, s3: X },
            submit: true,
            expect: { build: 'needs review', screens: { s1: 'no changes', s3: 'new' } }
        });
        await h.run({
            label: 'G1',
            branch: 'feat-g',
            base: ['M0'],
            screens: { s1: A, s3: X },
            expect: { build: 'changes approved', screens: { s3: 'changes approved' }, decisionFrom: { s3: 'F1' } }
        });
        await h.run({
            label: 'M1',
            branch: 'main',
            base: ['M1', 'M0'],
            screens: { s1: A, s3: X },
            expect: { build: 'changes approved', screens: { s3: 'changes approved' } }
        });
    },

    // ancestry decides the reference, not recency
    async ancestryOverRecency(h) {
        await h.run(baseline({ s1: A }));
        await h.run({ label: 'M1', branch: 'main', base: ['M1', 'M0'], screens: { s1: C }, submit: true, expect: { build: 'needs review' } });
        await h.run({
            label: 'Z1',
            branch: 'feat-z',
            base: ['no-build-for-this-commit', 'M0'],
            screens: { s1: A },
            expect: { build: 'no changes', screens: { s1: 'no changes' }, reference: { step: 'M0', source: 'ancestor' } }
        });
    },

    // #8: unchanged rows hold nothing of their own; once their uploads are gone, baselines and previews still work
    async cleanup(h) {
        await h.run(baseline({ s1: A, s2: X }));
        const m1 = await h.run({
            label: 'M1',
            branch: 'main',
            base: ['M1', 'M0'],
            screens: { s1: A, s2: X },
            expect: { build: 'no changes', screens: { s1: 'no changes', s2: 'no changes' } }
        });
        const s3 = h.s3();
        const pending = await BuildScreenEntity.query().filter({ appId: h.appId, storageStatus: 'pendingDeletion' }).find();
        assertTrue(pending.length >= 2, 'M1 rows are pendingDeletion');
        // the storage cleaner removes them: nothing points at those uploads any more
        const doomed = pending.map(row => s3.getPathForScreen(h.appId, row.buildId, row.screenId));
        const gc = h.facade.get<StorageGcService>(StorageGcService);
        const gcCtx = createGcContext(gc.getSettings(), { mode: 'delete', graceMs: 0, now: new Date(Date.now() + 120_000), deadlineAt: Infinity });
        for (const buildId of new Set(pending.map(row => row.buildId))) await gc.reclaimBuild(h.appId, buildId, undefined, gcCtx);
        for (const key of doomed) assertTrue(!(await s3.exists(key)), `the cleaner deleted ${key}`);
        assertTrue(!(await s3.exists(s3.getPathForScreen(h.appId, m1.buildId, m1.screenIds.s1))), 'the unchanged row upload is gone');

        const f1 = await h.run({
            label: 'F1',
            branch: 'feat-f',
            base: ['M1', 'M0'],
            screens: { s1: B, s2: X },
            expect: { build: 'needs review', screens: { s1: 'needs review', s2: 'no changes' } }
        });
        const preview = await h.call<IBuildScreenCompareResponse>(
            h.user(HttpRequest.POST(`/api/apps/${h.appId}/builds/${f1.buildId}/screens/${f1.screenIds.s1}/compare`)).json({
                colorTolerance: 0.2,
                shiftTolerance: 1,
                diffPctTolerance: 0.01,
                masks: []
            })
        );
        assertEq(preview.passes, false, 'compare still works against the source image');
    },

    // main moves between a branch's approval and another branch's auto-approval: the diff and images still describe G's own comparison
    async diffConsistency(h) {
        await h.run(baseline({ s1: A }));
        const f1 = await h.run({ label: 'F1', branch: 'feat-f', base: ['M0'], screens: { s1: B }, submit: true, expect: { build: 'needs review' } });
        await h.run({ label: 'M1', branch: 'main', base: ['M1', 'M0'], screens: { s1: C }, submit: true, expect: { build: 'needs review' } });
        const g1 = await h.run({
            label: 'G1',
            branch: 'feat-g',
            base: ['M0'],
            screens: { s1: B },
            expect: { build: 'changes approved', screens: { s1: 'changes approved' }, decisionFrom: { s1: 'F1' } }
        });
        const s3 = h.s3();
        // computed against G's baseline (A, from M0), exactly like F1's: the same bytes
        const gDiff = await s3.getBuffer(s3.getPathForDiff(h.appId, g1.buildId, g1.screenIds.s1));
        const fDiff = await s3.getBuffer(s3.getPathForDiff(h.appId, f1.buildId, f1.screenIds.s1));
        assertTrue(gDiff.equals(fDiff), "G1's diff is the diff of its own comparison (A vs B)");
        // the UI/external image rule: a changed row shows its own upload, an unchanged one the image it equals
        const row = g1.rows.s1;
        const imageBuildId = row.status === 'no changes' ? (row.matchedBuildId ?? row.buildId) : row.buildId;
        assertEq(imageBuildId, g1.buildId, "G1's image is its own upload");
        assertEq(row.matchedBuildId, f1.buildId, 'while the decision image is F1');
    },

    // concurrent processing and approval
    async concurrent(h) {
        await h.run(baseline({ s1: A }));
        const [a, b] = await Promise.all([
            h.run({
                label: 'Ca',
                branch: 'feat-a',
                base: ['M0'],
                screens: { s1: B },
                expect: { build: 'needs review', screens: { s1: 'needs review' } }
            }),
            h.run({
                label: 'Cb',
                branch: 'feat-b',
                base: ['M0'],
                screens: { s1: B },
                expect: { build: 'needs review', screens: { s1: 'needs review' } }
            })
        ]);
        const codes = await Promise.all([h.submit(a.buildId), h.submit(a.buildId)]);
        assertEq([...codes].sort(), [200, 400], 'a double approval gives one 200 and one 400');
        assertEq(await ScreenDecisionEntity.query().filter({ buildId: a.buildId }).count(), 1, 'one decision, not two');

        assertEq(await h.submit(b.buildId), 200, 'the other build approves');
        const newest = (await ScreenDecisionEntity.query().filter({ buildId: b.buildId }).findOne()).id;
        await h.run({
            label: 'Cc',
            branch: 'feat-c',
            base: ['M0'],
            screens: { s1: B },
            expect: { build: 'changes approved', screens: { s1: 'changes approved' } },
            then: async c => assertEq(c.rows.s1.decisionId, newest, 'the newest decision approves it')
        });
    },

    // an oversized canvas can't be pixel-compared, but a byte-identical approved image still matches
    async canvasTooLarge(h, facade) {
        const config = facade.app.config as unknown as { SCREEN_MAX_PIXELS: number };
        const cap = config.SCREEN_MAX_PIXELS;
        config.SCREEN_MAX_PIXELS = 50_000;
        try {
            const tall = solid(100, 400, [128, 128, 128]);
            const wide = solid(400, 100, [255, 0, 0]);
            await h.run(baseline({ s1: tall }));
            await h.run({
                label: 'F1',
                branch: 'feat-f',
                base: ['M0'],
                screens: { s1: wide },
                submit: true,
                expect: { build: 'needs review', screens: { s1: 'needs review' } }
            });
            await h.run({
                label: 'G1',
                branch: 'feat-g',
                base: ['M0'],
                screens: { s1: Buffer.from(wide) },
                expect: { build: 'changes approved', screens: { s1: 'changes approved' }, decisionFrom: { s1: 'F1' } }
            });
        } finally {
            config.SCREEN_MAX_PIXELS = cap;
        }
    },

    // at most one baseline comparison plus four decision comparisons per screen
    async costBound(h) {
        const gray = solid(200, 200, [128, 128, 128]);
        const colors: [number, number, number][] = [
            [255, 0, 0],
            [0, 255, 0],
            [0, 0, 255],
            [255, 255, 0],
            [255, 0, 255],
            [0, 255, 255],
            [128, 0, 128]
        ];
        await h.run(baseline({ s1: gray }));
        for (let i = 0; i < 6; i++) {
            await h.run({
                label: `Y${i + 1}`,
                branch: `feat-y${i + 1}`,
                base: ['M0'],
                screens: { s1: solid(200, 200, colors[i]) },
                submit: true,
                expect: { build: 'needs review', screens: { s1: 'needs review' } }
            });
        }
        const getDiff = mock.method(PixelMatchService.prototype, 'getDiff');
        try {
            await h.run({
                label: 'Y7',
                branch: 'feat-y7',
                base: ['M0'],
                screens: { s1: solid(200, 200, colors[6]) },
                expect: { build: 'needs review', screens: { s1: 'needs review' } }
            });
            assertTrue(getDiff.mock.callCount() <= 5, `at most 1 + 4 comparisons, got ${getDiff.mock.callCount()}`);
            assertTrue(getDiff.mock.callCount() >= 1, 'the baseline was compared');
        } finally {
            getDiff.mock.restore();
        }
    },

    // the migration backfills a reference for builds from before 0.8
    async migrationBackfill(h, facade) {
        const sleep = () => sleepSecs(0.01);
        const mk = async (branchId: string, status: BuildStatus, extra: Partial<BuildEntity> = {}) => {
            await sleep();
            const id = uuid7();
            await createPersistedEntity(BuildEntity, {
                id,
                appId: h.appId,
                branchId,
                createdAt: new Date(),
                commitHash: createHash('sha1').update(id).digest('hex'),
                commitSubject: 'legacy',
                commitAuthor: 'legacy',
                ciJobId: `legacy-${id}`,
                ciTokenHash: null,
                ciReadTokenHashes: [],
                status,
                approvedById: null,
                approvedAt: null,
                ciTokensExpireAt: null,
                ciRunId: null,
                manifestCount: null,
                manifestHash: null,
                processingAttemptId: null,
                processingHeartbeatAt: null,
                processingStartedAt: null,
                baseCommits: null,
                baseSource: null,
                referenceBuildId: null,
                referenceSource: null,
                ...extra
            });
            return id;
        };
        const featBranchId = uuid7();
        await createPersistedEntity(BranchEntity, { id: featBranchId, appId: h.appId, name: 'legacy-feat' });

        const early = await mk(featBranchId, 'needs review'); // before any approved main build
        const m1 = await mk(h.mainBranchId, 'changes approved');
        const m2 = await mk(h.mainBranchId, 'changes approved');
        const mPending = await mk(h.mainBranchId, 'needs review'); // not a reference
        const feat = await mk(featBranchId, 'needs review');
        const draft = await mk(featBranchId, 'draft');
        const already = await mk(featBranchId, 'needs review', { referenceBuildId: m1, referenceSource: 'ancestor' });

        await backfillLegacyReferences(facade.get(Db));
        const got = async (id: string) => {
            const b = await BuildEntity.query().filter({ id }).findOne();
            return [b.referenceBuildId, b.referenceSource];
        };
        assertEq(await got(early), [null, 'legacy'], 'before any approved main build: no reference, still marked legacy');
        assertEq(await got(m2), [m1, 'legacy'], 'a main build: the earlier approved main build');
        assertEq(await got(mPending), [m2, 'legacy'], 'a pending main build: the latest approved before it');
        assertEq(await got(feat), [m2, 'legacy'], 'a branch build: the latest approved main build before it');
        assertEq(await got(draft), [null, null], 'a draft is untouched');
        assertEq(await got(already), [m1, 'ancestor'], 'a build that already has a reference is untouched');
    },

    // review finding: a mark that only came from a decision pre-mark is not carried to the branch's next build
    async staleCarry(h) {
        await h.run(baseline({ s1: A }));
        const r1 = await h.run({
            label: 'R1',
            branch: 'feat-r',
            base: ['M0'],
            screens: { s1: B },
            review: { s1: 'rejected' },
            submit: true,
            expect: { build: 'needs review', screens: { s1: 'needs review' }, afterSubmit: 'changes rejected' }
        });
        await h.run({
            label: 'F1',
            branch: 'feat-f',
            base: ['M0'],
            screens: { s1: B },
            expect: { build: 'needs review', screens: { s1: ['needs review', 'rejected'] }, decisionFrom: { s1: 'R1' } }
        });
        await h.revoke((await h.decisionOf((await h.rowsOf(r1.buildId)).s1))!.id);
        const f2 = await h.run({
            label: 'F2',
            branch: 'feat-f',
            base: ['M0'],
            screens: { s1: B },
            expect: { build: 'needs review', screens: { s1: ['needs review', null as unknown as string] } }
        });
        assertEq([f2.rows.s1.reviewStatus, f2.rows.s1.reviewCarriedFromId, f2.rows.s1.decisionId], [null, null, null], 'F2 carries nothing');
        assertEq(await h.submit(f2.buildId), 200, 'F2 submit');
        assertEq((await BuildEntity.query().filter({ id: f2.buildId }).findOne()).status, 'changes approved', 'F2 approves');
    },

    // review finding: a reviewer who flips a pre-marked row owns the mark; the row no longer points at the old decision
    async reviewClearsDecision(h) {
        await h.run(baseline({ s1: A, s2: A }));
        await h.run({
            label: 'R1',
            branch: 'feat-r',
            base: ['M0'],
            screens: { s1: B, s2: A },
            review: { s1: 'rejected' },
            submit: true,
            expect: { build: 'needs review', afterSubmit: 'changes rejected' }
        });
        const f1 = await h.run({
            label: 'F1',
            branch: 'feat-f',
            base: ['M0'],
            screens: { s1: B, s2: C },
            review: { s1: 'approved', s2: 'rejected' },
            submit: true,
            expect: { build: 'needs review', screens: { s1: ['needs review', 'rejected'] }, afterSubmit: 'changes rejected' }
        });
        const rows = await h.rowsOf(f1.buildId);
        assertEq(
            [rows.s1.reviewStatus, rows.s1.decisionId, rows.s1.reviewCarriedFromId],
            ['approved', null, null],
            "flipped row is the reviewer's own"
        );
        const screens = await h.getScreens(f1.buildId);
        const s1 = screens.find(s => s.screenId === f1.screenIds.s1)!;
        const p = s1 as { decision?: unknown; decisionId?: unknown };
        assertTrue(!p.decision && !p.decisionId, 'no decision reported on the approved row');
        assertEq((await h.decisionOf(rows.s2))?.kind, 'rejected', 's2 keeps its own rejection decision');
    },

    // review finding: a legacy in-flight build's carried reviewer is not who decides; the submitter is
    async legacyAttribution(h, facade) {
        await h.run(baseline({ s1: A }));
        const other = uuid7();
        await createPersistedEntity(UserEntity, {
            id: other,
            name: 'Someone Else',
            createdAt: new Date(),
            lastLoginAt: new Date(),
            isAdmin: false,
            vcsId: ZERO_ID,
            vcsUserId: other
        });
        const f1 = await h.run({ label: 'F1', branch: 'feat-f', base: ['M0'], screens: { s1: B }, expect: { build: 'needs review' } });
        await BuildEntity.query().filter({ id: f1.buildId }).patchMany({ referenceSource: null });
        await BuildScreenEntity.query()
            .filter({ id: f1.rows.s1.id })
            .patchMany({ reviewStatus: 'approved', reviewedById: other, reviewedAt: new Date() });
        assertEq(await h.submit(f1.buildId), 200, 'legacy submit');
        const d = await h.decisionOf((await h.rowsOf(f1.buildId)).s1);
        assertEq(d?.decidedById, ZERO_ID, 'the submitter decides on a legacy build');
        void facade;
    }
};
