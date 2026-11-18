import { MutexAcquisitionError, ScopedLogger, withMutex } from '@zyno-io/ts-server-foundation';

import { AppConfig } from '../../config';
import { Db } from '../../database';
import { AppEntity } from '../../entities/App.entity';
import { BranchEntity } from '../../entities/Branch.entity';
import { BuildEntity } from '../../entities/Build.entity';
import { BuildScreenEntity } from '../../entities/BuildScreen.entity';
import { BuildShardEntity } from '../../entities/BuildShard.entity';
import { ScreenEntity } from '../../entities/Screen.entity';
import { ScreenDecisionEntity } from '../../entities/ScreenDecision.entity';
import { StorageSweepEntity } from '../../entities/StorageSweep.entity';
import { type IS3Object, S3Service } from '../S3.service';
import { classifyBuildObjects, type IBuildFacts, type IClassification, type IOwnRow } from './StorageGcPolicy';
import { type IStorageGcSettings, resolveStorageGcSettings } from './StorageGcSettings';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APP_PREFIX_RE = /^screens\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/$/;
const DAY_MS = 86_400_000;
const PURGE_BUILD_CHUNK = 200;
export const STORAGE_GC_MUTEX_KEY = 'pixelci:storage-gc';

export interface IGcStats {
    objectsScanned: number;
    /** Objects that are garbage and old enough to delete, by kind. */
    garbage: { upload: number; diff: number; thumb: number };
    deleted: { count: number; bytes: number };
    wouldDelete: { count: number; bytes: number };
    /** Garbage inside the grace period. */
    skippedYoung: number;
    /** Objects kept because something references them (or their build is not final). */
    skippedLive: number;
    keptByReason: Record<string, number>;
    /** Objects whose build row is missing. */
    unknownBuild: number;
    /** Keys that are not ours; never deleted. */
    unrecognized: number;
    deleteErrors: number;
    appsSwept: number;
    appsPurged: number;
    /** Dry-run only: apps that a delete-mode run would purge. */
    appsWouldPurge: number;
    /** App ids found in the bucket with no app row. */
    unknownAppPrefixes: string[];
    /** Set when the run stopped at its time budget. */
    outOfTime: boolean;
}

export function newGcStats(): IGcStats {
    return {
        objectsScanned: 0,
        garbage: { upload: 0, diff: 0, thumb: 0 },
        deleted: { count: 0, bytes: 0 },
        wouldDelete: { count: 0, bytes: 0 },
        skippedYoung: 0,
        skippedLive: 0,
        keptByReason: {},
        unknownBuild: 0,
        unrecognized: 0,
        deleteErrors: 0,
        appsSwept: 0,
        appsPurged: 0,
        appsWouldPurge: 0,
        unknownAppPrefixes: [],
        outOfTime: false
    };
}

export interface IGcContext {
    /** dry-run never deletes anything and never records progress (cursors, sweep times). */
    mode: 'dry-run' | 'delete';
    graceMs: number;
    now: Date;
    /** Epoch ms after which no new unit of work starts. */
    deadlineAt: number;
    sweepIntervalMs: number;
    purgeAfterDays: number;
    deleteUnknownApps: boolean;
    /** Sweep every app now, whatever its last sweep time (the command). */
    force: boolean;
    /** Lets a caller end a run early, checked wherever the deadline is (tests use it to stop between build groups). */
    shouldStop?: () => boolean;
    stats: IGcStats;
}

export function createGcContext(settings: IStorageGcSettings, overrides: Partial<IGcContext> = {}): IGcContext {
    return {
        mode: settings.mode === 'delete' ? 'delete' : 'dry-run',
        graceMs: settings.graceMs,
        now: new Date(),
        deadlineAt: Date.now() + settings.maxRunMs,
        sweepIntervalMs: settings.sweepIntervalMs,
        purgeAfterDays: settings.purgeAfterDays,
        deleteUnknownApps: settings.deleteUnknownApps,
        force: false,
        stats: newGcStats(),
        ...overrides
    };
}

const outOfTime = (ctx: IGcContext) => {
    if (Date.now() < ctx.deadlineAt && !ctx.shouldStop?.()) return false;
    ctx.stats.outOfTime = true;
    return true;
};

export class StorageGcService {
    constructor(
        private s3: S3Service,
        private db: Db,
        private appConfig: AppConfig,
        private logger: ScopedLogger
    ) {}

    getSettings(): IStorageGcSettings {
        const settings = resolveStorageGcSettings(this.appConfig);
        for (const warning of settings.warnings) this.logger.warn(warning);
        return settings;
    }

    /**
     * Runs fn under the cluster-wide cleanup lock. Returns false (without running) when another run holds it.
     * Reclaims, sweeps and purges all share it, so two of them never classify the same objects at once.
     */
    async withLock(fn: () => Promise<void>): Promise<boolean> {
        try {
            // redis, not the default in-process lock: workers and the command run in different processes
            await withMutex({ key: STORAGE_GC_MUTEX_KEY, retryCount: 0, mode: 'redis', fn });
            return true;
        } catch (err) {
            if (err instanceof MutexAcquisitionError) return false;
            throw err;
        }
    }

    // ---- facts ----------------------------------------------------------------------------------------------------------------

    /** Everything the policy needs to know about one build: its rows, and who else points at its uploads. */
    async loadBuildFacts(appId: string, buildId: string): Promise<IBuildFacts> {
        const build = await BuildEntity.query().filter({ id: buildId, appId }).select('id', 'status').findOneOrUndefined();
        const facts: IBuildFacts = {
            appId,
            buildId,
            build: build ? { status: build.status } : null,
            ownRows: new Map(),
            inboundMatched: new Set(),
            inboundBase: new Set(),
            decisionScreens: new Set()
        };
        if (!build) return facts;

        const own = await BuildScreenEntity.query()
            .filter({ buildId })
            .select('id', 'screenId', 'isRemoved', 'storageStatus', 'status', 'matchedBuildId')
            .find();
        const ownRows = new Map<string, IOwnRow>();
        for (const row of own) {
            ownRows.set(row.screenId, {
                id: row.id,
                isRemoved: row.isRemoved,
                storageStatus: row.storageStatus,
                status: row.status,
                matchedBuildId: row.matchedBuildId
            });
        }
        const matched = await BuildScreenEntity.query().filter({ matchedBuildId: buildId }).select('screenId').find();
        const base = await BuildScreenEntity.query().filter({ baseImageBuildId: buildId }).select('screenId').find();
        const from = await ScreenDecisionEntity.query().filter({ fromImageBuildId: buildId }).select('screenId').find();
        const to = await ScreenDecisionEntity.query().filter({ toImageBuildId: buildId }).select('screenId').find();
        return {
            ...facts,
            ownRows,
            inboundMatched: new Set(matched.map(r => r.screenId)),
            inboundBase: new Set(base.map(r => r.screenId)),
            decisionScreens: new Set([...from, ...to].map(r => r.screenId))
        };
    }

    // ---- one build ------------------------------------------------------------------------------------------------------------

    /** Classifies (and in delete mode deletes the garbage of) one build's objects. Lists the build's prefix when none are given. */
    async reclaimBuild(appId: string, buildId: string, objects: IS3Object[] | undefined, ctx: IGcContext): Promise<IClassification> {
        const list = objects ?? (await this.listAll(`screens/${appId}/${buildId}/`));
        return this.processBuildObjects(appId, buildId, list, ctx);
    }

    private async listAll(prefix: string): Promise<IS3Object[]> {
        const all: IS3Object[] = [];
        let after: string | undefined;
        for (;;) {
            const page = await this.s3.listObjects(prefix, { startAfter: after });
            all.push(...page.objects);
            if (!page.nextToken || !page.objects.length) return all;
            after = page.objects[page.objects.length - 1].key;
        }
    }

    private async processBuildObjects(appId: string, buildId: string, objects: IS3Object[], ctx: IGcContext): Promise<IClassification> {
        const facts = await this.loadBuildFacts(appId, buildId);
        const cls = classifyBuildObjects(objects, facts, { now: ctx.now, graceMs: ctx.graceMs });
        const stats = ctx.stats;
        stats.objectsScanned += objects.length;
        stats.skippedYoung += cls.young.length;
        stats.unknownBuild += cls.unknownBuild;
        stats.unrecognized += cls.unrecognized.length;
        for (const [reason, n] of Object.entries(cls.kept)) {
            stats.keptByReason[reason] = (stats.keptByReason[reason] ?? 0) + n;
            stats.skippedLive += n;
        }
        for (const g of cls.garbage) stats.garbage[g.kind]++;
        await this.deleteObjects(cls.garbage, ctx);
        return cls;
    }

    /** Deletes (delete mode) or counts (dry-run) the given objects. */
    private async deleteObjects(objects: IS3Object[], ctx: IGcContext): Promise<number> {
        if (!objects.length) return 0;
        const size = new Map(objects.map(o => [o.key, o.size ?? 0]));
        if (ctx.mode !== 'delete') {
            ctx.stats.wouldDelete.count += objects.length;
            ctx.stats.wouldDelete.bytes += objects.reduce((sum, o) => sum + (o.size ?? 0), 0);
            return 0;
        }
        const res = await this.s3.deleteFiles(objects.map(o => o.key));
        ctx.stats.deleted.count += res.deleted.length;
        ctx.stats.deleted.bytes += res.deleted.reduce((sum, key) => sum + (size.get(key) ?? 0), 0);
        ctx.stats.deleteErrors += res.failed.length;
        for (const f of res.failed.slice(0, 5))
            this.logger.warn('Storage cleanup could not delete an object', { key: f.key, error: String(f.error) });
        return res.failed.length;
    }

    // ---- one app --------------------------------------------------------------------------------------------------------------

    /**
     * Walks an app's prefix one build group at a time (keys sort by build id, so a build's keys are contiguous), resuming from the
     * stored cursor. Returns true when it reached the end of the prefix. Dry-run walks from the start and records nothing.
     */
    async sweepApp(appId: string, ctx: IGcContext): Promise<boolean> {
        const prefix = `screens/${appId}/`;
        const persist = ctx.mode === 'delete';
        const sweep = persist ? await StorageSweepEntity.query().filter({ appId }).findOneOrUndefined() : undefined;
        let after = sweep?.cursor && sweep.cursor.startsWith(prefix) ? sweep.cursor : undefined;

        let group: { id: string; objects: IS3Object[] } | undefined;
        const flush = async (): Promise<boolean> => {
            if (!group) return true;
            if (outOfTime(ctx)) return false;
            const { id, objects } = group;
            group = undefined;
            if (UUID_RE.test(id)) {
                await this.processBuildObjects(appId, id, objects, ctx);
            } else {
                ctx.stats.objectsScanned += objects.length;
                ctx.stats.unrecognized += objects.length;
            }
            if (persist) await this.saveSweep(appId, { cursor: objects[objects.length - 1].key });
            return true;
        };

        for (;;) {
            const page = await this.s3.listObjects(prefix, { startAfter: after });
            for (const object of page.objects) {
                const rest = object.key.slice(prefix.length).split('/');
                const id = rest.length >= 2 ? rest[0] : '';
                if (group && group.id !== id && !(await flush())) return false;
                (group ??= { id, objects: [] }).objects.push(object);
            }
            if (!page.nextToken || !page.objects.length) break;
            after = page.objects[page.objects.length - 1].key;
        }
        if (!(await flush())) return false;

        ctx.stats.appsSwept++;
        if (persist) await this.saveSweep(appId, { cursor: null, sweptAt: ctx.now });
        return true;
    }

    private async saveSweep(appId: string, patch: { cursor?: string | null; sweptAt?: Date | null }) {
        const values = { ...patch, updatedAt: new Date() };
        const res = await StorageSweepEntity.query().filter({ appId }).patchMany(values);
        if (res.affectedRows) return;
        const row = new StorageSweepEntity();
        row.appId = appId;
        row.sweptAt = patch.sweptAt ?? null;
        row.cursor = patch.cursor ?? null;
        row.updatedAt = values.updatedAt;
        await row.save();
    }

    /**
     * Removes a soft-deleted app for good: every object under its prefix, then its rows, the apps row last, so a crash anywhere
     * leaves an app that the next run purges again. Returns true when the app is gone. Dry-run only counts.
     */
    async purgeApp(appId: string, ctx: IGcContext): Promise<boolean> {
        const cutoff = new Date(ctx.now.getTime() - ctx.purgeAfterDays * DAY_MS);
        const app = await AppEntity.query()
            .filter({ id: appId, deletedAt: { $lte: cutoff } })
            .findOneOrUndefined();
        if (!app) return false;

        const prefix = `screens/${appId}/`;
        let after: string | undefined;
        let failures = 0;
        for (;;) {
            if (outOfTime(ctx)) return false;
            const page = await this.s3.listObjects(prefix, { startAfter: after });
            if (!page.objects.length) break;
            ctx.stats.objectsScanned += page.objects.length;
            failures += await this.deleteObjects(page.objects, ctx);
            if (!page.nextToken) break;
            after = page.objects[page.objects.length - 1].key;
        }
        if (ctx.mode !== 'delete') {
            ctx.stats.appsWouldPurge++;
            return false;
        }
        if (failures) return false;

        for (;;) {
            if (outOfTime(ctx)) return false;
            const builds = await BuildEntity.query().filter({ appId }).select('id').limit(PURGE_BUILD_CHUNK).find();
            if (!builds.length) break;
            const ids = builds.map(b => b.id);
            await this.db.transaction(async txn => {
                await txn
                    .query(BuildScreenEntity)
                    .filter({ buildId: { $in: ids } })
                    .deleteMany();
                await txn
                    .query(BuildShardEntity)
                    .filter({ buildId: { $in: ids } })
                    .deleteMany();
                await txn
                    .query(BuildEntity)
                    .filter({ id: { $in: ids } })
                    .deleteMany();
            });
        }
        await this.db.transaction(async txn => {
            await txn.query(ScreenDecisionEntity).filter({ appId }).deleteMany();
            await txn.query(BranchEntity).filter({ appId }).deleteMany();
            await txn.query(ScreenEntity).filter({ appId }).deleteMany();
            await txn.query(StorageSweepEntity).filter({ appId }).deleteMany();
            await txn.query(AppEntity).filter({ id: appId }).deleteMany();
        });
        ctx.stats.appsPurged++;
        return true;
    }

    // ---- the bucket -----------------------------------------------------------------------------------------------------------

    /**
     * Finds screens/<id>/ prefixes that belong to no app row. Report only (stats.unknownAppPrefixes), unless the context allows
     * deleting them; then objects past the grace period are deleted (delete mode) or counted (dry-run).
     */
    async sweepUnknownAppPrefixes(ctx: IGcContext, opts: { appIdFilter?: string } = {}): Promise<void> {
        const candidates: string[] = [];
        if (opts.appIdFilter) {
            if (UUID_RE.test(opts.appIdFilter)) candidates.push(`screens/${opts.appIdFilter}/`);
        } else {
            let token: string | undefined;
            do {
                const page = await this.s3.listCommonPrefixes('screens/', token);
                candidates.push(...page.prefixes);
                token = page.nextToken;
            } while (token);
        }

        for (const prefix of candidates) {
            if (outOfTime(ctx)) return;
            const m = APP_PREFIX_RE.exec(prefix);
            if (!m) {
                ctx.stats.unrecognized++;
                continue;
            }
            const id = m[1];
            // Checked per prefix, right before acting: an app created since the run began must not look unknown.
            if ((await AppEntity.query().filter({ id }).count()) > 0) continue;
            if (opts.appIdFilter && !(await this.s3.listObjects(prefix, { maxKeys: 1 })).objects.length) continue;
            ctx.stats.unknownAppPrefixes.push(id);
            if (!ctx.deleteUnknownApps) continue;

            const youngBefore = ctx.now.getTime() - ctx.graceMs;
            let after: string | undefined;
            for (;;) {
                if (outOfTime(ctx)) return;
                const page = await this.s3.listObjects(prefix, { startAfter: after });
                if (!page.objects.length) break;
                ctx.stats.objectsScanned += page.objects.length;
                const old = page.objects.filter(o => o.lastModified && o.lastModified.getTime() <= youngBefore);
                ctx.stats.skippedYoung += page.objects.length - old.length;
                await this.deleteObjects(old, ctx);
                if (!page.nextToken) break;
                after = page.objects[page.objects.length - 1].key;
            }
        }
    }

    // ---- a whole pass ---------------------------------------------------------------------------------------------------------

    /** Purges due apps, then sweeps apps (in-progress first, then the longest unswept), then looks for unknown prefixes. */
    async run(ctx: IGcContext, opts: { appIdFilter?: string } = {}): Promise<IGcStats> {
        const apps = await AppEntity.query().select('id', 'deletedAt').find();
        const filtered = opts.appIdFilter ? apps.filter(a => a.id === opts.appIdFilter) : apps;
        const purgeCutoff = ctx.now.getTime() - ctx.purgeAfterDays * DAY_MS;

        for (const app of filtered) {
            if (!app.deletedAt || app.deletedAt.getTime() > purgeCutoff) continue;
            if (outOfTime(ctx)) break;
            try {
                await this.purgeApp(app.id, ctx);
            } catch (err) {
                this.logger.error('Storage cleanup failed to purge an app', err as Error, { appId: app.id });
            }
        }

        const sweeps = new Map((await StorageSweepEntity.query().find()).map(s => [s.appId, s]));
        const interval = ctx.sweepIntervalMs;
        const due = filtered
            .filter(a => !a.deletedAt)
            .filter(a => {
                const sweep = sweeps.get(a.id);
                // dry-run records nothing, so every app is always due
                return (
                    ctx.force || ctx.mode !== 'delete' || !sweep?.sweptAt || !!sweep.cursor || ctx.now.getTime() - sweep.sweptAt.getTime() >= interval
                );
            })
            .sort((a, b) => {
                const sa = sweeps.get(a.id);
                const sb = sweeps.get(b.id);
                if (!!sa?.cursor !== !!sb?.cursor) return sa?.cursor ? -1 : 1;
                return (sa?.sweptAt?.getTime() ?? 0) - (sb?.sweptAt?.getTime() ?? 0);
            });
        for (const app of due) {
            if (outOfTime(ctx)) break;
            try {
                await this.sweepApp(app.id, ctx);
            } catch (err) {
                this.logger.error('Storage cleanup failed to sweep an app', err as Error, { appId: app.id });
            }
        }

        if (!outOfTime(ctx)) {
            try {
                await this.sweepUnknownAppPrefixes(ctx, { appIdFilter: opts.appIdFilter });
            } catch (err) {
                this.logger.error('Storage cleanup failed to scan for unknown app prefixes', err as Error);
            }
        }

        this.logger.info('Storage cleanup run finished', { mode: ctx.mode, ...ctx.stats });
        return ctx.stats;
    }
}
