import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IGitLabConfig } from '../../src/entities/VcsIntegration.entity';
import { VcsGitLabService } from '../../src/services/VcsGitLab.service';

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
