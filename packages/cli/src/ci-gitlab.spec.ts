import assert from 'node:assert/strict';
import { describe, it, beforeEach, after } from 'node:test';

import { baseHints, getGitLabCiInfo } from './ci-gitlab.js';

describe('getGitLabCiInfo', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env = { ...originalEnv };
    });

    after(() => {
        process.env = originalEnv;
    });

    it('should return CI info when all required env vars are present', () => {
        process.env.CI_PROJECT_URL = 'https://gitlab.com/test/project';
        process.env.CI_JOB_TOKEN = 'glcbt-test-token';

        const result = getGitLabCiInfo();

        assert.deepStrictEqual(result, {
            projectUrl: 'https://gitlab.com/test/project',
            ciToken: 'glcbt-test-token'
        });
    });

    it('should return null when CI_PROJECT_URL is missing', () => {
        delete process.env.CI_PROJECT_URL;
        process.env.CI_JOB_TOKEN = 'glcbt-test-token';

        assert.equal(getGitLabCiInfo(), null);
    });

    it('should return null when CI_JOB_TOKEN is missing', () => {
        process.env.CI_PROJECT_URL = 'https://gitlab.com/test/project';
        delete process.env.CI_JOB_TOKEN;

        assert.equal(getGitLabCiInfo(), null);
    });
});

describe('gitlab baseHints', () => {
    it('only trusts the target sha for merged results and merge trains', () => {
        const env = { CI_MERGE_REQUEST_TARGET_BRANCH_SHA: 't', CI_MERGE_REQUEST_DIFF_BASE_SHA: 'd' };
        assert.equal(baseHints({ ...env, CI_MERGE_REQUEST_EVENT_TYPE: 'merged_result' }).mergeRequestTargetSha, 't');
        assert.equal(baseHints({ ...env, CI_MERGE_REQUEST_EVENT_TYPE: 'merge_train' }).mergeRequestTargetSha, 't');
        assert.equal(baseHints({ ...env, CI_MERGE_REQUEST_EVENT_TYPE: 'detached' }).mergeRequestTargetSha, undefined);
        assert.equal(baseHints(env).mergeRequestDiffBaseSha, 'd');
        assert.deepEqual(baseHints({}), { mergeRequestTargetSha: undefined, mergeRequestDiffBaseSha: undefined });
    });
});
