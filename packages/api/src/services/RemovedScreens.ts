import { createEntity, uuid7 } from '@zyno-io/ts-server-foundation';

import { BuildScreenEntity } from '../entities/BuildScreen.entity';

/**
 * Computes tombstone rows for screens that exist in the reference build but are missing from the current build.
 * A tombstone has no image (`isRemoved = true`, `storageStatus = null`). It is pre-approved when the same removal
 * is already approved on this branch (previous approved build) or explicitly approved on another branch since the
 * reference build; otherwise it needs review.
 */
export async function computeRemovals(opts: {
    appId: string;
    buildId: string;
    currentScreenIds: Iterable<string>;
    /** Non-tombstone rows of the reference build. */
    referenceRows: BuildScreenEntity[];
    previousTombstonesById: Record<string, BuildScreenEntity | undefined>;
}): Promise<BuildScreenEntity[]> {
    const present = new Set(opts.currentScreenIds);
    const tombstones: BuildScreenEntity[] = [];

    for (const ref of opts.referenceRows) {
        if (ref.isRemoved || present.has(ref.screenId)) continue;

        let status: BuildScreenEntity['status'] = 'needs review';
        let approvalBuildId: string | null = null;

        const previous = opts.previousTombstonesById[ref.screenId];
        if (previous?.status === 'changes approved') {
            status = 'changes approved';
            approvalBuildId = previous.approvalBuildId ?? previous.buildId;
        } else {
            // an explicitly approved removal on another branch since the reference build
            const lowerBound = ref.approvalBuildId ?? ref.buildId;
            const approved = await BuildScreenEntity.query()
                .filter({
                    appId: opts.appId,
                    screenId: ref.screenId,
                    isRemoved: true,
                    status: 'changes approved',
                    approvalBuildId: null,
                    id: { $gt: lowerBound }
                })
                .orderBy('id', 'asc')
                .findOneOrUndefined();
            if (approved) {
                status = 'changes approved';
                approvalBuildId = approved.buildId;
            }
        }

        tombstones.push(
            createEntity(BuildScreenEntity, {
                id: uuid7(),
                appId: opts.appId,
                buildId: opts.buildId,
                screenId: ref.screenId,
                matchedBuildId: null,
                approvalBuildId,
                status,
                storageStatus: null,
                reviewStatus: null,
                reviewComment: null,
                reviewedById: null,
                reviewedAt: null,
                isRemoved: true
            })
        );
    }

    return tombstones;
}
