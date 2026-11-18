import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, DatabaseField, UuidString } from '@zyno-io/ts-server-foundation';

/** Where the storage cleaner is in an app's S3 prefix. Kept out of `apps`, which is exposed through the API. */
@entity.name('storage_sweeps')
export class StorageSweepEntity extends BaseEntity {
    appId!: UuidString & PrimaryKey;
    /** When a full pass over the app's prefix last finished. */
    sweptAt!: Date | null;
    /** Last S3 key of the last build group classified in a pass that has not finished; null when none is in progress. */
    cursor!: (string & DatabaseField<{ type: 'text' }>) | null;
    updatedAt!: Date;
}
