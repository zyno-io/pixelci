import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, DatabaseField, UuidString } from '@zyno-io/ts-server-foundation';

@entity.name('builds_screens')
@entity.index(['buildId', 'screenId'])
@entity.index(['screenId', 'id'])
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
}
