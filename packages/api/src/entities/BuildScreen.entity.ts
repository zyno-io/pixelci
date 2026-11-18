import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, DatabaseField, HasDefault, UuidString } from '@zyno-io/ts-server-foundation';

import { IMaskRect } from '../services/Mask';

@entity.name('builds_screens')
@entity.index(['buildId', 'screenId'], { unique: true })
@entity.index(['screenId', 'id'])
// The storage cleaner looks up the rows that still point at a build's upload.
@entity.index(['matchedBuildId', 'screenId'])
@entity.index(['baseImageBuildId', 'screenId'])
export class BuildScreenEntity extends BaseEntity {
    id!: UuidString & PrimaryKey;
    appId!: UuidString;
    buildId!: UuidString;
    screenId!: UuidString;
    matchedBuildId!: UuidString | null; // when a screen matches a previous build's, we can reference that build instead of storing identical images
    approvalBuildId!: UuidString | null; // when a screen is previously approved, we point to the build that approved it
    status!: 'new' | 'no changes' | 'needs review' | 'changes approved' | null;
    storageStatus!: 'stored' | 'pendingDeletion' | null;
    reviewStatus!: 'approved' | 'rejected' | null; // per-screen reviewer decision while a build is being reviewed
    reviewComment!: (string & DatabaseField<{ type: 'text' }>) | null;
    reviewedById!: UuidString | null;
    reviewedAt!: Date | null;
    /** The shard (1-based) that uploaded this screen; always 1 for unsharded builds. */
    shardIndex: (number & DatabaseField<{ type: 'integer' }>) & HasDefault = 1;
    /** What was masked (ignored) when this screen was processed: the audit record the review screen draws. Null before masks existed. */
    appliedMasks!: IMaskRect[] | null;
    isRemoved: boolean & HasDefault = false; // tombstone: the screen is in the reference build but removed from this one; no image
    /** sha256 hex of this row's own uploaded PNG bytes; null for tombstones and pre-0.8 uploads (filled lazily by processing). Immutable. */
    contentHash!: (string & DatabaseField<{ type: 'varchar(64)' }>) | null;
    /** Image source of the baseline this row was compared with (null: not in the baseline). Tombstones: the removed image. */
    baseImageBuildId!: UuidString | null;
    /** The decision behind this row's outcome: matched approval, pre-marking rejection, or the decision made in this build. */
    decisionId!: UuidString | null;
    /** Pre-mark carried from this (originating) build screen on an earlier build of the same branch. */
    reviewCarriedFromId!: UuidString | null;
}
