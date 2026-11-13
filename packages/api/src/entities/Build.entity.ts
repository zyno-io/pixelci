import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, DatabaseField, HasDefault, UuidString } from '@zyno-io/ts-server-foundation';

@entity.name('builds')
@entity.index(['appId', 'createdAt'])
@entity.index(['branchId', 'id'])
@entity.index(['branchId', 'commitHash'], { unique: true })
@entity.index(['status', 'processingStartedAt'])
export class BuildEntity extends BaseEntity {
    id!: UuidString & PrimaryKey;
    appId!: UuidString;
    branchId!: UuidString;
    createdAt!: Date;
    commitHash!: string;
    commitSubject!: string & DatabaseField<{ type: 'text' }>;
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
    /** CI session tokens (uploader and readers) stop working after this; refreshed on create and on each upload. Null counts as expired. */
    ciTokensExpireAt!: Date | null;
    /** Identifies one CLI run; a repeated create with the same id doesn't clear that run's uploads. */
    ciRunId!: (string & DatabaseField<{ type: 'varchar(64)' }>) | null;
    /** Screen manifest declared by the uploader at create (null from older CLIs): number of screens and sha256 of the sorted names. */
    manifestCount!: (number & DatabaseField<{ type: 'integer' }>) | null;
    manifestHash!: (string & DatabaseField<{ type: 'varchar(64)' }>) | null;
    /** Number of CI jobs the suite is split across (PIXELCI_SHARD total); 1 = unsharded. */
    shardTotal: (number & DatabaseField<{ type: 'integer' }>) & HasDefault = 1;
    /** Fencing token of the job attempt that currently owns processing; null when unowned. */
    processingAttemptId!: UuidString | null;
    /** Last heartbeat of the owning attempt; a stale value means the attempt died. */
    processingHeartbeatAt!: Date | null;
    /** When the build entered `processing` (hard cap on total processing time). */
    processingStartedAt!: Date | null;
    /** How many times processing has been claimed. */
    processingAttempts: number & DatabaseField<{ type: 'integer' }> & HasDefault = 0;
}
