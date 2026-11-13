import { BuildEntity } from '../entities/Build.entity';

export type IBuildResponse = Pick<BuildEntity, 'id' | 'branchId' | 'commitHash' | 'commitSubject' | 'commitAuthor' | 'createdAt' | 'status'> & {
    branchName: string;
};

/** Explicit whitelist: responses are serialized as-is, so never spread the entity (it carries CI credential hashes). */
export function toBuildResponse(build: BuildEntity, branchName: string, status: BuildEntity['status'] = build.status): IBuildResponse {
    return {
        id: build.id,
        branchId: build.branchId,
        commitHash: build.commitHash,
        commitSubject: build.commitSubject,
        commitAuthor: build.commitAuthor,
        createdAt: build.createdAt,
        status,
        branchName
    };
}
