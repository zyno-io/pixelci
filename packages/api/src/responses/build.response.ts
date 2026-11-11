import { BuildEntity } from '../entities/Build.entity';

export type IBuildResponse = Pick<BuildEntity, 'id' | 'branchId' | 'commitHash' | 'commitSubject' | 'commitAuthor' | 'createdAt' | 'status'> & {
    branchName: string;
    /** Echo of the shard the caller registered as (sharded builds only); lets the CLI detect a server that ignores `shard`. */
    shard?: { index: number; total: number };
};

/** Explicit whitelist: responses are serialized as-is, so never spread the entity (it carries CI credential hashes). */
export function toBuildResponse(
    build: BuildEntity,
    branchName: string,
    status: BuildEntity['status'] = build.status,
    shard?: { index: number; total: number }
): IBuildResponse {
    return {
        id: build.id,
        branchId: build.branchId,
        commitHash: build.commitHash,
        commitSubject: build.commitSubject,
        commitAuthor: build.commitAuthor,
        createdAt: build.createdAt,
        status,
        branchName,
        ...(shard ? { shard: { index: shard.index, total: shard.total } } : {})
    };
}
