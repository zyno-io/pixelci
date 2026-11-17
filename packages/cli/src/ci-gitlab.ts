import type { ICIJobInfo } from './ci.js';

export function getGitLabCiInfo(): ICIJobInfo | null {
    const { CI_PROJECT_URL, CI_JOB_TOKEN } = process.env;
    if (!CI_PROJECT_URL || !CI_JOB_TOKEN) {
        return null;
    }

    return {
        projectUrl: CI_PROJECT_URL,
        ciToken: CI_JOB_TOKEN
    };
}

export interface IGitLabBaseHints {
    /** Target-branch tip of a merged-results pipeline (the merge commit's first parent). */
    mergeRequestTargetSha?: string;
    /** The MR's diff base: the merge base with the target branch, for branch pipelines of an MR. */
    mergeRequestDiffBaseSha?: string;
}

export function baseHints(env: NodeJS.ProcessEnv): IGitLabBaseHints {
    const mergedResult = env.CI_MERGE_REQUEST_EVENT_TYPE === 'merged_result' || env.CI_MERGE_REQUEST_EVENT_TYPE === 'merge_train';
    return {
        mergeRequestTargetSha: mergedResult && env.CI_MERGE_REQUEST_TARGET_BRANCH_SHA ? env.CI_MERGE_REQUEST_TARGET_BRANCH_SHA : undefined,
        mergeRequestDiffBaseSha: env.CI_MERGE_REQUEST_DIFF_BASE_SHA || undefined
    };
}
