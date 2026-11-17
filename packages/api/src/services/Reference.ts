import { HttpBadRequestError } from '@zyno-io/ts-server-foundation';
import { keyBy } from 'lodash';

import { AppEntity } from '../entities/App.entity';
import { BuildEntity } from '../entities/Build.entity';
import { BuildScreenEntity } from '../entities/BuildScreen.entity';

/**
 * Builds whose rows form a complete baseline. A `no changes` build is complete too (every screen `no changes`, no
 * tombstones), so its rows (each matched to the image it equals) stand in for the build it was compared with.
 */
export const ACCEPTED: BuildEntity['status'][] = ['changes approved', 'no changes'];

export type IReferenceSource = 'ancestor' | 'latest' | 'none';

export interface IResolvedReference {
    build?: BuildEntity;
    source: IReferenceSource;
}

/** Pure: the first of `baseCommits` (nearest first) that has an accepted default-branch build. */
export function pickAncestorReference<T extends { commitHash: string }>(baseCommits: string[], candidates: T[]): T | undefined {
    const byHash = keyBy(candidates, 'commitHash');
    for (const sha of baseCommits) if (byHash[sha]) return byHash[sha];
    return undefined;
}

/**
 * The default-branch build this build is compared with: the accepted build at (or nearest before) the merge base, when
 * the CLI reported one; otherwise the latest accepted default-branch build (source `latest`, which the UI warns about).
 */
export async function resolveReference(app: AppEntity, build: BuildEntity): Promise<IResolvedReference> {
    if (!app.defaultBranchId) return { source: 'none' };

    if (build.baseCommits?.length) {
        const hits = await BuildEntity.query()
            .filter({
                appId: app.id,
                branchId: app.defaultBranchId,
                commitHash: { $in: build.baseCommits },
                status: { $in: ACCEPTED },
                id: { $ne: build.id }
            })
            .find();
        const hit = pickAncestorReference(build.baseCommits, hits);
        if (hit) return { build: hit, source: 'ancestor' };
    }

    const latest = await BuildEntity.query()
        .filter({ appId: app.id, branchId: app.defaultBranchId, status: { $in: ACCEPTED }, id: { $lt: build.id } })
        .orderBy('id', 'desc')
        .findOneOrUndefined();
    return latest ? { build: latest, source: 'latest' } : { source: 'none' };
}

/**
 * For display, compare and approve: the reference stored when the build was processed. Only a build that was never
 * processed by 0.8+ (referenceSource null: a 0.7 pod, or still in flight) falls back to the pre-0.8 rule: the latest
 * approved default-branch build before it.
 */
export async function referenceForBuild(app: AppEntity, build: BuildEntity): Promise<BuildEntity | undefined> {
    if (build.referenceSource) {
        if (!build.referenceBuildId) return undefined;
        return BuildEntity.query().filter({ id: build.referenceBuildId, appId: app.id }).findOneOrUndefined();
    }
    if (!app.defaultBranchId) return undefined;
    return BuildEntity.query()
        .filter({ appId: app.id, branchId: app.defaultBranchId, status: 'changes approved', id: { $lt: build.id } })
        .orderBy('id', 'desc')
        .findOneOrUndefined();
}

export interface IBaseline {
    /** The reference build's row for the screen. */
    refRow: BuildScreenEntity;
    /** The build whose upload holds the baseline pixels: `refRow.matchedBuildId ?? refRow.buildId`. */
    sourceBuildId: string;
    /** The row holding those pixels (the reference row itself when it has no match). */
    sourceRowId: string;
    /** sha256 of the baseline pixels' PNG bytes; null for pre-0.8 uploads. */
    hash: string | null;
}

/**
 * The reference build's baseline per screen: two queries (its non-removed rows, then the source rows they point at).
 * Keyed by screenId.
 */
export async function loadBaselines(appId: string, refBuildId: string): Promise<Map<string, IBaseline>> {
    const refRows = await BuildScreenEntity.query().filter({ appId, buildId: refBuildId, isRemoved: false }).find();
    const baselines = new Map<string, IBaseline>();
    if (!refRows.length) return baselines;

    const sourceBuildIds = [...new Set(refRows.map(r => r.matchedBuildId ?? r.buildId).filter(id => id !== refBuildId))];
    const sourceRows = sourceBuildIds.length
        ? await BuildScreenEntity.query()
              .filter({ appId, screenId: { $in: refRows.map(r => r.screenId) }, buildId: { $in: sourceBuildIds }, isRemoved: false })
              .find()
        : [];
    const sourceRowsByKey = keyBy(sourceRows, r => `${r.buildId}:${r.screenId}`);

    for (const refRow of refRows) {
        const sourceBuildId = refRow.matchedBuildId ?? refRow.buildId;
        const sourceRow = sourceBuildId === refBuildId ? refRow : sourceRowsByKey[`${sourceBuildId}:${refRow.screenId}`];
        baselines.set(refRow.screenId, {
            refRow,
            sourceBuildId,
            sourceRowId: (sourceRow ?? refRow).id,
            hash: sourceRow?.contentHash ?? null
        });
    }
    return baselines;
}

export const BASE_SOURCES = [
    'merge-base',
    'merge-request-target',
    'merge-request-diff-base',
    'pull-request-base',
    'first-parent',
    'override'
] as const;
export type IBaseSource = (typeof BASE_SOURCES)[number];
export interface IBase {
    commits: string[];
    source: IBaseSource;
}
export const MAX_BASE_COMMITS = 50;
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Validates the `base` a CLI sends with `process`: 1 to 50 commit hashes (nearest first, de-duplicated) and a known source. */
export function validateBase(base: IBase | undefined): IBase | undefined {
    if (base === undefined) return undefined;
    if (!base || !Array.isArray(base.commits) || base.commits.length < 1 || base.commits.length > MAX_BASE_COMMITS) {
        throw new HttpBadRequestError(`base.commits must be an array of 1 to ${MAX_BASE_COMMITS} commit hashes`);
    }
    if (!base.commits.every(c => typeof c === 'string' && COMMIT_RE.test(c))) {
        throw new HttpBadRequestError('base.commits must be lowercase hex commit hashes (40 or 64 characters)');
    }
    if (!(BASE_SOURCES as readonly string[]).includes(base.source)) {
        throw new HttpBadRequestError(`base.source must be one of ${BASE_SOURCES.join(', ')}`);
    }
    return { commits: [...new Set(base.commits)], source: base.source };
}
