import { type IS3Object, parseScreensKey } from '../S3.service';

/**
 * Decides which S3 objects of one build are garbage. Pure: the service loads the facts and performs the deletes.
 *
 * Safety invariant (why deleting without locks is safe):
 *  - New references only ever point at live, stored uploads. A baseline source is `refRow.matchedBuildId ?? refRow.buildId`
 *    (Reference.ts), a decision's `from` is that baseline source, and its `to` is the reviewed row's own upload.
 *  - A build's own rows change only while it is draft or processing, or on takeover of a canceled/failed build.
 *  - So for a build in a final status, an object that nothing references now can never become referenced again, and
 *    it can be deleted without locking against processing or review.
 *  - Everything else is skipped: draft, processing, canceled and failed builds, and keys whose build row is missing
 *    (unless the whole app is being purged, which does not use this module).
 *
 * When in doubt an object is kept, and counted.
 */

/** Statuses after which a build's rows no longer change. */
export const FINAL_BUILD_STATUSES: readonly string[] = ['no changes', 'needs review', 'changes approved', 'changes rejected'];

export interface IOwnRow {
    id: string;
    isRemoved: boolean;
    storageStatus: 'stored' | 'pendingDeletion' | null;
    status: string | null;
    matchedBuildId: string | null;
}

export interface IBuildFacts {
    appId: string;
    buildId: string;
    /** Null when there is no such build in this app. */
    build: { status: string } | null;
    /** This build's own rows, by screen id. */
    ownRows: ReadonlyMap<string, IOwnRow>;
    /** Screens for which some row has matchedBuildId = this build. */
    inboundMatched: ReadonlySet<string>;
    /** Screens for which some row has baseImageBuildId = this build (tombstones included). */
    inboundBase: ReadonlySet<string>;
    /** Screens for which some decision (revoked ones too) has this build as its from or to image. */
    decisionScreens: ReadonlySet<string>;
}

export interface IClassifiedObject extends IS3Object {
    kind: 'upload' | 'diff' | 'thumb';
}

export interface IClassification {
    garbage: IClassifiedObject[];
    /** Garbage that is newer than the grace period (or has no timestamp): left for a later pass. */
    young: IClassifiedObject[];
    /** Objects kept, by the rule that kept them. */
    kept: Record<string, number>;
    /** Keys that are not one of ours (or belong to another build/app than the group). Never deleted. */
    unrecognized: IS3Object[];
    /** Objects skipped because the build row is missing. */
    unknownBuild: number;
}

const bump = (kept: Record<string, number>, reason: string) => {
    kept[reason] = (kept[reason] ?? 0) + 1;
};

/** The reason an upload must be kept, or null when nothing needs it. */
export function uploadKeepReason(facts: IBuildFacts, screenId: string): string | null {
    const own = facts.ownRows.get(screenId);
    if (own && !own.isRemoved) {
        if (own.storageStatus !== 'pendingDeletion') return 'ownRow';
        // pendingDeletion is only ever written for an auto-approved row that points at another build's image. Anything else
        // (a null match, another status) is not a state we understand: keep the upload.
        if (own.matchedBuildId === null || own.status !== 'no changes') return 'inconsistentPending';
    }
    if (facts.inboundMatched.has(screenId)) return 'matchedBy';
    if (facts.inboundBase.has(screenId)) return 'baseOf';
    if (facts.decisionScreens.has(screenId)) return 'decision';
    return null;
}

export function classifyBuildObjects(objects: IS3Object[], facts: IBuildFacts, opts: { now: Date; graceMs: number }): IClassification {
    const result: IClassification = { garbage: [], young: [], kept: {}, unrecognized: [], unknownBuild: 0 };
    const youngBefore = opts.now.getTime() - opts.graceMs;

    for (const object of objects) {
        const parsed = parseScreensKey(object.key);
        if (!parsed || parsed.appId !== facts.appId || parsed.buildId !== facts.buildId) {
            result.unrecognized.push(object);
            continue;
        }
        if (!facts.build) {
            result.unknownBuild++;
            continue;
        }
        if (!FINAL_BUILD_STATUSES.includes(facts.build.status)) {
            bump(result.kept, 'buildNotFinal');
            continue;
        }

        let keep: string | null;
        if (parsed.kind === 'upload') {
            keep = uploadKeepReason(facts, parsed.screenId);
        } else if (parsed.kind === 'diff') {
            // The own row's diff, or (legacy fallback in the diff endpoint) a diff shown for a row that matched this build.
            const own = facts.ownRows.get(parsed.screenId);
            keep = own && !own.isRemoved ? 'ownRow' : facts.inboundMatched.has(parsed.screenId) ? 'matchedBy' : null;
        } else {
            // Kept while the row it was made for exists, whether or not the row still has an upload of its own: the thumbnail
            // endpoint serves (and makes) it for a row pending deletion from the image that row matched, and deleting it would
            // just have it rebuilt on the next view.
            const own = facts.ownRows.get(parsed.screenId);
            keep = own && !own.isRemoved && own.id === parsed.buildScreenId ? 'thumbnail' : null;
        }
        if (keep) {
            bump(result.kept, keep);
            continue;
        }

        const classified: IClassifiedObject = { ...object, kind: parsed.kind };
        // No timestamp: unsure, so treat as young.
        if (!object.lastModified || object.lastModified.getTime() > youngBefore) result.young.push(classified);
        else result.garbage.push(classified);
    }
    return result;
}
