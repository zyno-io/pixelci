import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, DatabaseField, UuidString } from '@zyno-io/ts-server-foundation';

/** One CI job's slice of a sharded build: its own upload token, declared manifest and upload state. */
@entity.name('builds_shards')
@entity.index(['buildId', 'shardIndex'], { unique: true })
@entity.index(['buildId', 'ciTokenHash'])
export class BuildShardEntity extends BaseEntity {
    id!: UuidString & PrimaryKey;
    buildId!: UuidString;
    /** 1-based. */
    shardIndex!: number & DatabaseField<{ type: 'integer' }>;
    ciTokenHash!: string;
    ciJobId!: string;
    state!: ('uploading' | 'uploaded') & DatabaseField<{ type: 'varchar(16)' }>;
    manifestCount!: number & DatabaseField<{ type: 'integer' }>;
    manifestHash!: string & DatabaseField<{ type: 'varchar(64)' }>;
    /** The CLI run that registered the shard; a repeat create with the same runId doesn't clear its uploads. */
    runId!: (string & DatabaseField<{ type: 'varchar(64)' }>) | null;
    /** Last create/upload activity while `uploading`; drives shard staleness. */
    activeAt!: Date;
}
