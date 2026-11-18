import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IGitLabConfig } from '../../src/entities/VcsIntegration.entity';
import { gitlabIdTokenAudiences, mapGitLabIdTokenClaims, VcsGitLabService } from '../../src/services/VcsGitLab.service';

const make = (config: Partial<IGitLabConfig>) =>
    new VcsGitLabService({ url: 'https://gitlab.example.com', clientId: 'cid', clientSecret: 's', ...config } as IGitLabConfig, {} as never);

describe('VcsGitLabService.getProviderLoginUrl', () => {
    it('encodes client id, redirect uri and state', async () => {
        const raw = await make({ clientId: 'a&b=c d' }).getProviderLoginUrl('https://p.example.com/login?x=1&y=2', 's t&a=te');
        const url = new URL(raw);
        assert.equal(url.origin + url.pathname, 'https://gitlab.example.com/oauth/authorize');
        assert.equal(url.searchParams.get('client_id'), 'a&b=c d');
        assert.equal(url.searchParams.get('redirect_uri'), 'https://p.example.com/login?x=1&y=2');
        assert.equal(url.searchParams.get('state'), 's t&a=te');
        assert.equal(url.searchParams.get('response_type'), 'code');
        assert.equal(url.searchParams.get('scope'), 'openid api');
        assert.deepEqual([...url.searchParams.keys()].sort(), ['client_id', 'redirect_uri', 'response_type', 'scope', 'state']);
    });

    it('keeps a path prefix in the GitLab url', async () => {
        const raw = await make({ url: 'https://example.com/gitlab' }).getProviderLoginUrl('https://p.example.com/login', 'st');
        assert.ok(raw.startsWith('https://example.com/gitlab/oauth/authorize?'), raw);
    });
});

describe('rerunTargets', () => {
    const svc = new VcsGitLabService({ url: 'https://gitlab.example.com' } as never, { info() {}, warn() {}, error() {} } as never);
    it('retries each distinct job', () => {
        assert.deepEqual(svc.rerunTargets(['11', '12', '13']), ['11', '12', '13']);
        assert.deepEqual(svc.rerunTargets(['11', '12', '11']), ['11', '12']);
    });
});

describe('gitlabIdTokenAudiences', () => {
    it('uses the PUBLIC_URL origin with and without a trailing slash', () => {
        assert.deepEqual(gitlabIdTokenAudiences({ PUBLIC_URL: 'https://p.example.com' }), ['https://p.example.com', 'https://p.example.com/']);
    });

    it('drops a PUBLIC_URL path', () => {
        assert.deepEqual(gitlabIdTokenAudiences({ PUBLIC_URL: 'https://p.example.com/app/' }), ['https://p.example.com', 'https://p.example.com/']);
    });

    it('yields nothing for an unset or invalid PUBLIC_URL', () => {
        assert.deepEqual(gitlabIdTokenAudiences({}), []);
        assert.deepEqual(gitlabIdTokenAudiences({ PUBLIC_URL: 'not a url' }), []);
        assert.deepEqual(gitlabIdTokenAudiences({ PUBLIC_URL: 'ftp://p.example.com' }), []);
    });

    it('adds comma-separated extras, normalised and de-duplicated', () => {
        assert.deepEqual(
            gitlabIdTokenAudiences({
                PUBLIC_URL: 'https://p.example.com',
                GITLAB_ID_TOKEN_AUDIENCES: ' https://a.example.com/ , ,https://p.example.com,https://b.example.com//'
            }),
            [
                'https://p.example.com',
                'https://p.example.com/',
                'https://a.example.com',
                'https://a.example.com/',
                'https://b.example.com',
                'https://b.example.com/'
            ]
        );
    });

    it('works with extras only', () => {
        assert.deepEqual(gitlabIdTokenAudiences({ GITLAB_ID_TOKEN_AUDIENCES: 'https://a.example.com' }), [
            'https://a.example.com',
            'https://a.example.com/'
        ]);
    });
});

describe('mapGitLabIdTokenClaims', () => {
    const good = { project_id: '42', job_id: '7', ref: 'main', sha: 'a'.repeat(40), user_login: 'ann' };

    it('maps the claims and hints', () => {
        const r = mapGitLabIdTokenClaims(good, { subject: 'Fix it\nbody', author: ' Ann Dev ' });
        assert.deepEqual(r, {
            ok: true,
            data: { jobId: '7', branch: 'main', commitHash: 'a'.repeat(40), commitSubject: 'Fix it', commitAuthor: 'Ann Dev', vcsProjectId: 42 }
        });
    });

    it('falls back to user_login for the author and accepts SHA-256 shas', () => {
        const r = mapGitLabIdTokenClaims({ ...good, sha: 'b'.repeat(64) }, { subject: 'x' });
        assert.ok(r.ok);
        assert.equal(r.data.commitAuthor, 'ann');
        assert.equal(r.data.commitHash, 'b'.repeat(64));
        assert.equal(mapGitLabIdTokenClaims(good).ok && (mapGitLabIdTokenClaims(good) as { data: { commitSubject: string } }).data.commitSubject, '');
    });

    it('caps subject and author at 255 characters', () => {
        const r = mapGitLabIdTokenClaims(good, { subject: 's'.repeat(400), author: 'a'.repeat(400) });
        assert.ok(r.ok);
        assert.equal(r.data.commitSubject.length, 255);
        assert.equal(r.data.commitAuthor.length, 255);
    });

    it('rejects bad claims', () => {
        const bad: Record<string, unknown>[] = [
            { project_id: undefined },
            { project_id: '' },
            { project_id: '0' },
            { project_id: '-1' },
            { project_id: '1.5' },
            { project_id: '99999999999999999999' },
            { project_id: 42 },
            { job_id: undefined },
            { job_id: 'abc' },
            { job_id: 7 },
            { ref: '' },
            { ref: undefined },
            { sha: undefined },
            { sha: 'A'.repeat(40) },
            { sha: 'a'.repeat(39) },
            { sha: 'g'.repeat(40) }
        ];
        for (const override of bad) {
            const r = mapGitLabIdTokenClaims({ ...good, ...override });
            assert.equal(r.ok, false, JSON.stringify(override));
        }
    });
});

describe('mapGitLabIdTokenClaims merge request pipelines', () => {
    const mr = { project_id: '42', job_id: '7', ref: 'feature', sha: 'a'.repeat(40), pipeline_source: 'merge_request_event' };
    const branchOf = (eventType?: string) => {
        const r = mapGitLabIdTokenClaims(mr, { mergeRequest: { iid: '9', eventType } });
        assert.ok(r.ok);
        return r.data.branch;
    };

    it('maps the event type to the pseudo-ref suffix', () => {
        assert.equal(branchOf('merged_result'), 'refs/merge-requests/9/merge');
        assert.equal(branchOf('merge_train'), 'refs/merge-requests/9/train');
        assert.equal(branchOf('detached'), 'refs/merge-requests/9/head');
        assert.equal(branchOf(undefined), 'refs/merge-requests/9/head');
    });

    it('needs a numeric iid', () => {
        for (const hints of [undefined, {}, { mergeRequest: {} }, { mergeRequest: { iid: 'x' } }, { mergeRequest: { iid: '1/2' } }]) {
            const r = mapGitLabIdTokenClaims(mr, hints);
            assert.ok(!r.ok && r.badRequest);
        }
    });

    it('ignores the hint for other pipeline sources', () => {
        const r = mapGitLabIdTokenClaims({ ...mr, pipeline_source: 'push' }, { mergeRequest: { iid: '9', eventType: 'merged_result' } });
        assert.ok(r.ok);
        assert.equal(r.data.branch, 'feature');
    });
});
