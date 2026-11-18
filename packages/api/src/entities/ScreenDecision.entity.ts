import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, DatabaseField, HasDefault, UuidString } from '@zyno-io/ts-server-foundation';

/**
 * One approved or rejected change to a screen: from one image (or none) to another (or none).
 * An image is identified by its image source (the build whose upload holds the pixels) plus a sha256 of the PNG bytes.
 */
@entity.name('screen_decisions')
@entity.index(['appId', 'screenId', 'id'])
@entity.index(['buildScreenId'], { unique: true }) // one decision per reviewed row: idempotency guard
// The storage cleaner looks up the decisions that still use a build's upload.
@entity.index(['fromImageBuildId', 'screenId'])
@entity.index(['toImageBuildId', 'screenId'])
export class ScreenDecisionEntity extends BaseEntity {
    id!: UuidString & PrimaryKey; // uuid7 minted at decision time: ordering + epoch comparisons
    appId!: UuidString;
    screenId!: UuidString;
    kind!: ('approved' | 'rejected') & DatabaseField<{ type: 'varchar(16)' }>; // varchar, per App.entity.ts note
    fromImageBuildId!: UuidString | null; // image source build of the baseline; null = screen absent from baseline
    fromHash!: (string & DatabaseField<{ type: 'varchar(64)' }>) | null;
    toImageBuildId!: UuidString | null; // image source of the result; null = removal
    toHash!: (string & DatabaseField<{ type: 'varchar(64)' }>) | null;
    buildId!: UuidString; // build the decision was made in
    branchId!: UuidString;
    buildScreenId!: UuidString; // the reviewed row (tombstone row for removals)
    branchScoped: boolean & HasDefault = false; // approval made against a guessed baseline: reused on its own branch only
    decidedById!: UuidString;
    decidedAt!: Date;
    comment!: (string & DatabaseField<{ type: 'text' }>) | null;
    revokedAt!: Date | null;
    revokedById!: UuidString | null;
}
