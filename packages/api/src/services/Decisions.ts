import { createEntity, sql, uuid7 } from '@zyno-io/ts-server-foundation';
import { keyBy, uniq } from 'lodash';

import { Db } from '../database';
import { BranchEntity } from '../entities/Branch.entity';
import { BuildEntity } from '../entities/Build.entity';
import { BuildScreenEntity } from '../entities/BuildScreen.entity';
import { ScreenDecisionEntity } from '../entities/ScreenDecision.entity';
import { loadUserNames } from './Mask';

/** Compares only ids/times, so a decision "older than" an image is `decision.id < image row id`. All uuid7. */
export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export const MAX_DECISION_CANDIDATES = 20;
export const MAX_DECISION_PIXEL_COMPARES = 4;

type IDecisionKind = ScreenDecisionEntity['kind'];

/** The fields of a decision that matching looks at. */
export type IDecisionCandidate = Pick<ScreenDecisionEntity, 'id' | 'kind' | 'toImageBuildId' | 'toHash'>;

/** The result side of a change: an upload (identified by its hash, when it has one) or the screen being absent. */
export type IDecisionTarget = { hash: string | null } | 'absent';

/**
 * Pure. Picks the decision that applies from candidates ordered newest first: the newest one whose `to` side matches the
 * upload (hash first, then `match`, a pixel comparison against the candidate's image, under `budget` comparisons).
 * When the budget runs out, a candidate we couldn't check is only a problem if it could outrank the match we found
 * by being of the other kind (an unchecked newer rejection could block an approval, and vice versa): then there is no answer.
 */
export async function pickDecision<T extends IDecisionCandidate>(
    candidates: T[],
    upload: IDecisionTarget,
    match: (toImageBuildId: string) => Promise<boolean>,
    budget = MAX_DECISION_PIXEL_COMPARES
): Promise<T | undefined> {
    const unknownKinds = new Set<IDecisionKind>();
    const cache = new Map<string, boolean>();
    for (const c of candidates) {
        let m: boolean | undefined;
        if (upload === 'absent') m = c.toImageBuildId === null;
        else if (!c.toImageBuildId) m = false;
        else if (upload.hash && c.toHash === upload.hash) m = true;
        else if (cache.has(c.toImageBuildId)) m = cache.get(c.toImageBuildId);
        else if (budget > 0) {
            budget--;
            m = await match(c.toImageBuildId);
            cache.set(c.toImageBuildId, m);
        }
        if (m === undefined) {
            unknownKinds.add(c.kind);
            continue;
        }
        if (!m) continue;
        return [...unknownKinds].some(k => k !== c.kind) ? undefined : c;
    }
    return undefined;
}

export interface IFindDecisionOpts {
    appId: string;
    screenId: string;
    branchId: string;
    /** The baseline image (source build + hash); null when the screen is absent from the baseline. */
    from: { buildId: string; hash: string | null } | null;
    to: IDecisionTarget;
    /** Only decisions newer than this (a uuid7) apply: the baseline image's row id, or the absent-epoch. */
    epoch: string;
    /** Pixel comparison of the upload against a candidate's `to` image; must not throw (see `safeMatch`). */
    match: (toImageBuildId: string) => Promise<boolean>;
}

/** The newest live decision that turns `from` into something equal to `to` (see pickDecision). */
export async function findDecision(opts: IFindDecisionOpts): Promise<ScreenDecisionEntity | undefined> {
    const { from, to } = opts;
    const candidates = await ScreenDecisionEntity.query()
        .filter({
            appId: opts.appId,
            screenId: opts.screenId,
            revokedAt: null,
            id: { $gt: opts.epoch },
            toImageBuildId: to === 'absent' ? null : { $ne: null },
            $and: [
                from ? { $or: [{ fromImageBuildId: from.buildId }, ...(from.hash ? [{ fromHash: from.hash }] : [])] } : { fromImageBuildId: null },
                { $or: [{ branchScoped: false }, { branchId: opts.branchId }] }
            ]
        })
        .orderBy('id', 'desc')
        .limit(MAX_DECISION_CANDIDATES)
        .find();
    return pickDecision(candidates, to, opts.match);
}

/**
 * The id of the latest accepted default-branch removal of this screen at or before the reference build: decisions older
 * than it don't apply to a screen that has since come back. ZERO_UUID when it was never removed.
 */
export async function absentEpoch(db: Db, appId: string, screenId: string, defaultBranchId: string | null, refBuildId: string | undefined) {
    if (!defaultBranchId || !refBuildId) return ZERO_UUID;
    const row = await db.rawFindOne<{ id: string }>(sql`
        SELECT bs."id" FROM "builds_screens" bs JOIN "builds" b ON b."id" = bs."buildId"
        WHERE bs."appId" = ${appId} AND bs."screenId" = ${screenId} AND bs."isRemoved" AND b."branchId" = ${defaultBranchId}
          AND b."status" = 'changes approved' AND b."id" <= ${refBuildId}
        ORDER BY bs."id" DESC LIMIT 1`);
    return row?.id ?? ZERO_UUID;
}

export interface IDecisionInput {
    row: BuildScreenEntity;
    kind: IDecisionKind;
    from: { buildId: string; hash: string | null } | null;
    /** null: the screen was removed. */
    to: { buildId: string; hash: string | null } | null;
    decidedById: string;
    comment: string | null;
}

/** Inserts one decision per input through `txn` and points each row at its decision. The unique buildScreenId index guards double approval. */
export function recordDecisions(
    txn: { add: (...entities: object[]) => unknown },
    build: Pick<BuildEntity, 'id' | 'appId' | 'branchId'>,
    inputs: IDecisionInput[],
    opts: { branchScoped: boolean; now: Date }
): ScreenDecisionEntity[] {
    const decisions = inputs.map(input => {
        const decision = createEntity(ScreenDecisionEntity, {
            id: uuid7(),
            appId: build.appId,
            screenId: input.row.screenId,
            kind: input.kind,
            fromImageBuildId: input.from?.buildId ?? null,
            fromHash: input.from?.hash ?? null,
            toImageBuildId: input.to?.buildId ?? null,
            toHash: input.to?.hash ?? null,
            buildId: build.id,
            branchId: build.branchId,
            buildScreenId: input.row.id,
            branchScoped: opts.branchScoped,
            decidedById: input.decidedById,
            decidedAt: opts.now,
            comment: input.comment,
            revokedAt: null,
            revokedById: null
        });
        input.row.decisionId = decision.id;
        return decision;
    });
    if (decisions.length) txn.add(...decisions);
    return decisions;
}

export type IDecisionSummary = {
    id: string;
    kind: IDecisionKind;
    buildId: string;
    commitHash: string;
    branchName: string;
    decidedByName: string | null;
    decidedAt: Date;
    comment: string | null;
    revokedAt: Date | null;
    revokedByName: string | null;
    branchScoped: boolean;
};

/** Summaries for decisions by id: three batched queries (decisions, then their builds and branches, then user names). */
export async function loadDecisionSummaries(appId: string, ids: (string | null | undefined)[]): Promise<Map<string, IDecisionSummary>> {
    const decisionIds = uniq(ids.filter((id): id is string => !!id));
    const summaries = new Map<string, IDecisionSummary>();
    if (!decisionIds.length) return summaries;

    const decisions = await ScreenDecisionEntity.query()
        .filter({ appId, id: { $in: decisionIds } })
        .find();
    const builds = keyBy(
        await BuildEntity.query()
            .filter({ appId, id: { $in: uniq(decisions.map(d => d.buildId)) } })
            .select('id', 'commitHash')
            .find(),
        'id'
    );
    const branches = keyBy(
        await BranchEntity.query()
            .filter({ appId, id: { $in: uniq(decisions.map(d => d.branchId)) } })
            .select('id', 'name')
            .find(),
        'id'
    );
    const names = await loadUserNames(decisions.flatMap(d => [d.decidedById, d.revokedById]));

    for (const d of decisions) {
        summaries.set(d.id, {
            id: d.id,
            kind: d.kind,
            buildId: d.buildId,
            commitHash: builds[d.buildId]?.commitHash ?? '',
            branchName: branches[d.branchId]?.name ?? '',
            decidedByName: names[d.decidedById] ?? null,
            decidedAt: d.decidedAt,
            comment: d.comment,
            revokedAt: d.revokedAt,
            revokedByName: d.revokedById ? (names[d.revokedById] ?? null) : null,
            branchScoped: d.branchScoped
        });
    }
    return summaries;
}
