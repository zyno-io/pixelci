import { createEntity, uuid7 } from '@zyno-io/ts-server-foundation';

import { BuildScreenEntity } from '../entities/BuildScreen.entity';
import { ScreenDecisionEntity } from '../entities/ScreenDecision.entity';
import { IBaseline } from './Reference';

/**
 * Computes tombstone rows for screens that exist in the baseline but are missing from the current build.
 * A tombstone has no image (`isRemoved = true`, `storageStatus = null`) and records the removed image in `baseImageBuildId`.
 * It is pre-approved when an approved removal of that same image (`X -> absent`) is on record; otherwise it needs review.
 */
export async function computeRemovals(opts: {
    appId: string;
    buildId: string;
    currentScreenIds: Iterable<string>;
    baselines: Map<string, IBaseline>;
    findRemovalDecision: (screenId: string, baseline: IBaseline) => Promise<ScreenDecisionEntity | undefined>;
}): Promise<BuildScreenEntity[]> {
    const present = new Set(opts.currentScreenIds);
    const tombstones: BuildScreenEntity[] = [];

    for (const [screenId, baseline] of opts.baselines) {
        if (present.has(screenId)) continue;

        const decision = await opts.findRemovalDecision(screenId, baseline);
        const approved = decision?.kind === 'approved';

        tombstones.push(
            createEntity(BuildScreenEntity, {
                id: uuid7(),
                appId: opts.appId,
                buildId: opts.buildId,
                screenId,
                matchedBuildId: null,
                approvalBuildId: approved ? decision.buildId : null,
                status: approved ? 'changes approved' : 'needs review',
                storageStatus: null,
                reviewStatus: null,
                reviewComment: null,
                reviewedById: null,
                reviewedAt: null,
                isRemoved: true,
                contentHash: null,
                baseImageBuildId: baseline.sourceBuildId, // the removed image
                decisionId: approved ? decision.id : null,
                reviewCarriedFromId: null
            })
        );
    }

    return tombstones;
}
