import assert from 'node:assert/strict';
import { describe, it, beforeEach, after, afterEach, mock } from 'node:test';

import { baseHints, commitHints, getGitLabCiInfo } from './ci-gitlab.js';
import { AppError } from './error.js';

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

function jwt(payload: Record<string, unknown>): string {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(payload)}.c2ln`;
}

describe('getGitLabCiInfo with an ID token', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const base = { CI_PROJECT_URL: 'https://gitlab.com/g/p', CI_COMMIT_TITLE: 'Fix it', CI_COMMIT_AUTHOR: 'Ann Dev <ann@example.com>' };

    beforeEach(() => {
        mock.method(console, 'log', () => {});
        mock.method(console, 'warn', () => {});
    });
    afterEach(() => mock.restoreAll());

    it('wins over the job token and sends commit hints', () => {
        const token = jwt({ aud: 'https://pixelci.example.com', exp: future });
        const info = getGitLabCiInfo({ ...base, CI_JOB_TOKEN: 'glcbt-x', PIXELCI_ID_TOKEN: token }, 'https://pixelci.example.com');
        assert.deepEqual(info, {
            projectUrl: 'https://gitlab.com/g/p',
            ciToken: token,
            commit: { subject: 'Fix it', author: 'Ann Dev' }
        });
    });

    it('works without CI_JOB_TOKEN', () => {
        const token = jwt({ aud: 'https://pixelci.example.com/', exp: future });
        assert.equal(getGitLabCiInfo({ ...base, PIXELCI_ID_TOKEN: token }, 'https://pixelci.example.com')?.ciToken, token);
    });

    it('falls back to the job token when the value is blank', () => {
        assert.deepEqual(getGitLabCiInfo({ ...base, CI_JOB_TOKEN: 'glcbt-x', PIXELCI_ID_TOKEN: '  ' }), {
            projectUrl: 'https://gitlab.com/g/p',
            ciToken: 'glcbt-x'
        });
    });

    it('rejects a value that is not a JWT', () => {
        assert.throws(() => getGitLabCiInfo({ ...base, PIXELCI_ID_TOKEN: 'glcbt-nope' }), AppError);
    });

    it('rejects an expired token', () => {
        const token = jwt({ aud: 'x', exp: Math.floor(Date.now() / 1000) - 10 });
        assert.throws(() => getGitLabCiInfo({ ...base, PIXELCI_ID_TOKEN: token }), /expired/);
    });

    it('warns when aud does not include the API URL', () => {
        const token = jwt({ aud: ['https://other.example.com'], exp: future });
        getGitLabCiInfo({ ...base, PIXELCI_ID_TOKEN: token }, 'https://pixelci.example.com');
        assert.equal((console.warn as any).mock.callCount(), 1);
        assert.match((console.warn as any).mock.calls[0].arguments[0], /GITLAB_ID_TOKEN_AUDIENCES/);
    });

    it('does not warn when aud matches', () => {
        const token = jwt({ aud: ['https://other.example.com', 'https://pixelci.example.com'], exp: future });
        getGitLabCiInfo({ ...base, PIXELCI_ID_TOKEN: token }, 'https://pixelci.example.com/');
        assert.equal((console.warn as any).mock.callCount(), 0);
    });

    it('still requires CI_PROJECT_URL', () => {
        assert.equal(getGitLabCiInfo({ PIXELCI_ID_TOKEN: jwt({ exp: future }) }), null);
    });
});

describe('gitlab commitHints', () => {
    it('adds merge request details when present', () => {
        assert.deepEqual(commitHints({ CI_MERGE_REQUEST_IID: '12', CI_MERGE_REQUEST_EVENT_TYPE: 'merged_result' }), {
            mergeRequest: { iid: '12', eventType: 'merged_result' }
        });
        assert.deepEqual(commitHints({ CI_MERGE_REQUEST_IID: '12' }), { mergeRequest: { iid: '12' } });
    });

    it('parses the author name from "Name <email>" or keeps a bare value', () => {
        assert.deepEqual(commitHints({ CI_COMMIT_TITLE: ' T ', CI_COMMIT_AUTHOR: 'A B <a@b.c>' }), { subject: 'T', author: 'A B' });
        assert.deepEqual(commitHints({ CI_COMMIT_AUTHOR: 'Just Name' }), { author: 'Just Name' });
    });

    it('leaves out empty values', () => {
        assert.deepEqual(commitHints({ CI_COMMIT_TITLE: '  ', CI_COMMIT_AUTHOR: '<a@b.c>' }), {});
        assert.deepEqual(commitHints({}), {});
    });
});
