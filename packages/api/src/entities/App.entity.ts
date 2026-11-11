import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, DatabaseField, UuidString } from '@zyno-io/ts-server-foundation';

@entity.name('apps')
export class AppEntity extends BaseEntity {
    id!: UuidString & PrimaryKey;
    vcsId!: UuidString;
    projectPath!: string;
    vcsProjectId!: (number & DatabaseField<{ type: 'bigint' }>) | null;
    defaultBranchId!: UuidString | null;
    name!: string;
    deletedAt!: Date | null;
}
