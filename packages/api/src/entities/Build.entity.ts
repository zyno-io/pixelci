import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, HasDefault, UuidString } from '@zyno-io/ts-server-foundation';

@entity.name('builds')
export class BuildEntity extends BaseEntity {
    id!: UuidString & PrimaryKey;
    appId!: UuidString;
    branchId!: UuidString;
    createdAt!: Date;
    commitHash!: string;
    commitSubject!: string;
    commitAuthor!: string;
    ciJobId!: string;
    /** Uploader/creator token hash. */
    ciTokenHash!: string | null;
    /** Hashes of other CI tokens (concurrent jobs for the same commit) allowed to poll status only. */
    ciReadTokenHashes!: string[];
    /** Last upload/takeover activity while a draft; drives staleness (not createdAt). */
    draftActiveAt: Date & HasDefault = new Date();
    status!: 'draft' | 'processing' | 'no changes' | 'needs review' | 'changes approved' | 'changes rejected' | 'canceled' | 'failed';
    approvedById!: UuidString | null;
    approvedAt!: Date | null;
}
