import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, DatabaseField, HasDefault, UuidString } from '@zyno-io/ts-server-foundation';

/** Lowest VCS role a non-admin needs to review and approve an app's builds. 'read' = anyone who can see the app. */
export type IApprovalMinRole = 'read' | 'write' | 'maintain';

@entity.name('apps')
export class AppEntity extends BaseEntity {
    id!: UuidString & PrimaryKey;
    vcsId!: UuidString;
    projectPath!: string;
    vcsProjectId!: (number & DatabaseField<{ type: 'bigint' }>) | null;
    defaultBranchId!: UuidString | null;
    name!: string;
    deletedAt!: Date | null;
    // varchar, not a Postgres enum: TSF's schema reader can't strip the quoted cast of a camelCase enum default and reports drift.
    approvalMinRole: IApprovalMinRole & DatabaseField<{ type: 'varchar(16)' }> & HasDefault = 'write';
}
