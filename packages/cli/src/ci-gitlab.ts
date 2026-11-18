import type { ICIJobInfo } from './ci.js';

import { AppError } from './error.js';

const JWT_SHAPED_RE = /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/;

/** Decodes a JWT payload without verifying it (the server verifies); null when it isn't decodable. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    } catch {
        return null;
    }
}

/** Commit title and author name from GitLab's predefined variables; empty values are left out. */
export function commitHints(env: NodeJS.ProcessEnv): NonNullable<ICIJobInfo['commit']> {
    const subject = env.CI_COMMIT_TITLE?.trim();
    const rawAuthor = env.CI_COMMIT_AUTHOR?.trim();
    const author = rawAuthor ? (/^(.*?)\s*<[^>]*>\s*$/.exec(rawAuthor)?.[1] ?? rawAuthor).trim() : '';
    const iid = env.CI_MERGE_REQUEST_IID?.trim();
    const eventType = env.CI_MERGE_REQUEST_EVENT_TYPE?.trim();
    return {
        ...(subject && { subject }),
        ...(author && { author }),
        ...((iid || eventType) && { mergeRequest: { ...(iid && { iid }), ...(eventType && { eventType }) } })
    };
}

/**
 * Prefers a GitLab ID token (PIXELCI_ID_TOKEN, from `id_tokens:`) over CI_JOB_TOKEN. An ID token carries no commit
 * title or author, so those are sent along from the predefined variables.
 */
export function getGitLabCiInfo(env: NodeJS.ProcessEnv = process.env, apiUrl?: string): ICIJobInfo | null {
    const { CI_PROJECT_URL, CI_JOB_TOKEN } = env;
    if (!CI_PROJECT_URL) {
        return null;
    }

    const idToken = env.PIXELCI_ID_TOKEN?.trim();
    if (idToken) {
        if (!JWT_SHAPED_RE.test(idToken)) {
            throw new AppError('PIXELCI_ID_TOKEN is not a JWT. Declare it under "id_tokens:" in the job (see the GitLab setup docs).');
        }
        const claims = decodeJwtPayload(idToken);
        if (typeof claims?.exp === 'number' && claims.exp * 1000 <= Date.now()) {
            throw new AppError(
                'PIXELCI_ID_TOKEN has expired. GitLab ID tokens are valid only for the job that minted them (or the id_tokens lifetime).'
            );
        }
        if (apiUrl && claims) {
            const expected = apiUrl.replace(/\/+$/, '');
            const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
            if (!aud.some(a => typeof a === 'string' && a.replace(/\/+$/, '') === expected)) {
                console.warn(
                    "Warning: PIXELCI_ID_TOKEN's aud does not include PIXELCI_API_URL; make sure it is the server's PUBLIC_URL or listed in its GITLAB_ID_TOKEN_AUDIENCES."
                );
            }
        }
        console.log('Authenticating with the GitLab ID token (PIXELCI_ID_TOKEN)');
        return { projectUrl: CI_PROJECT_URL, ciToken: idToken, commit: commitHints(env) };
    }

    if (!CI_JOB_TOKEN) {
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
