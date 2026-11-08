import { importSPKI, jwtVerify } from 'jose';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { signAppJwt } from '../../src/services/github/GitHubAppAuth';
import { describeGitHubError, encodeRepoPath, githubUrls } from '../../src/services/github/GitHubHttp';
import {
    buildCiJobId,
    deriveBranch,
    extractCommitSubject,
    parseCiJobId,
    parseGitHubProjectUrl,
    parsePullNumber,
    VcsGitHubService
} from '../../src/services/VcsGitHub.service';

describe('githubUrls', () => {
    it('uses api.github.com for github.com', () => {
        assert.deepEqual(githubUrls({}), { web: 'https://github.com', api: 'https://api.github.com' });
        assert.deepEqual(githubUrls({ url: 'https://github.com/' }), { web: 'https://github.com', api: 'https://api.github.com' });
    });
    it('uses {url}/api/v3 for Enterprise and strips trailing slashes', () => {
        assert.deepEqual(githubUrls({ url: 'https://ghe.example.com//' }), { web: 'https://ghe.example.com', api: 'https://ghe.example.com/api/v3' });
    });
});

describe('ci job ids', () => {
    it('builds run:check when check_run_id is numeric', () => {
        assert.equal(buildCiJobId('987654', '128602857139'), '987654:128602857139');
        assert.equal(buildCiJobId('987654', undefined), '987654');
        assert.equal(buildCiJobId('987654', ''), '987654');
        assert.equal(buildCiJobId('987654', 'abc'), '987654');
    });
    it('parses stored ids', () => {
        assert.deepEqual(parseCiJobId('1:2'), { runId: '1', jobId: '2' });
        assert.deepEqual(parseCiJobId('1'), { runId: '1' });
        assert.equal(parseCiJobId('1:'), null);
        assert.equal(parseCiJobId('a:2'), null);
        assert.equal(parseCiJobId(''), null);
    });
});

describe('deriveBranch', () => {
    it('uses head_ref for pull_request only', () => {
        assert.equal(deriveBranch('pull_request', 'refs/pull/7/merge', 'feature/x'), 'feature/x');
        assert.equal(deriveBranch('push', 'refs/heads/main', 'evil'), 'main');
        assert.equal(deriveBranch('pull_request', 'refs/pull/7/merge', ''), null);
    });
    it('handles branches, tags and junk', () => {
        assert.equal(deriveBranch('push', 'refs/heads/release/1.0', ''), 'release/1.0');
        assert.equal(deriveBranch('push', 'refs/tags/v1.2.3', ''), 'v1.2.3');
        assert.equal(deriveBranch('push', 'refs/heads/', ''), null);
        assert.equal(deriveBranch('push', 'refs/other/x', ''), null);
    });
});

describe('commit subject', () => {
    it('takes the first line and truncates to 255', () => {
        assert.equal(extractCommitSubject('Fix bug\n\nlong body'), 'Fix bug');
        assert.equal(extractCommitSubject('Windows\r\nbody'), 'Windows');
        assert.equal(extractCommitSubject('x'.repeat(300)).length, 255);
        assert.equal(extractCommitSubject(undefined), '');
    });
    it('parses PR numbers from merge refs', () => {
        assert.equal(parsePullNumber('refs/pull/12/merge'), 12);
        assert.equal(parsePullNumber('refs/heads/main'), null);
    });
});

describe('parseProjectUrl', () => {
    it('extracts owner/repo from various URL shapes', () => {
        const web = 'https://github.com';
        assert.equal(parseGitHubProjectUrl(web, new URL('https://github.com/acme/app')), 'acme/app');
        assert.equal(parseGitHubProjectUrl(web, new URL('https://github.com/acme/app/pull/3')), 'acme/app');
        assert.equal(parseGitHubProjectUrl(web, new URL('https://github.com/acme/app.git')), 'acme/app');
        assert.equal(parseGitHubProjectUrl(web, new URL('https://GitHub.com/acme/app/')), 'acme/app');
    });
    it('rejects other hosts and short paths', () => {
        assert.equal(parseGitHubProjectUrl('https://github.com', new URL('https://evil.example/acme/app')), null);
        assert.equal(parseGitHubProjectUrl('https://github.com', new URL('https://github.com/acme')), null);
        assert.equal(parseGitHubProjectUrl('https://ghe.example.com', new URL('https://github.com/acme/app')), null);
        assert.equal(parseGitHubProjectUrl('https://ghe.example.com', new URL('https://ghe.example.com/acme/app')), 'acme/app');
    });
    it('is exposed on the service and getCommitUrlBase follows the web url', () => {
        const stub = { info() {}, warn() {}, error() {} } as never;
        const svc = new VcsGitHubService({ clientId: 'c', clientSecret: 's', oidcAudience: 'a', url: 'https://ghe.example.com/' }, stub);
        assert.equal(svc.parseProjectUrl(new URL('https://ghe.example.com/acme/app/issues')), 'acme/app');
        assert.equal(svc.getCommitUrlBase('acme/app'), 'https://ghe.example.com/acme/app/commit');
    });
});

describe('describeGitHubError', () => {
    it('flattens plain errors', () => {
        assert.deepEqual(describeGitHubError(new Error('nope')), { message: 'nope', rateLimited: false });
    });
    it('encodes repo paths segment-wise', () => {
        assert.equal(encodeRepoPath('acme/my app'), 'acme/my%20app');
    });
});

describe('signAppJwt', () => {
    const pair = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' }
    });

    it('signs with a PKCS#1 key: iss=appId, iat=now-60, exp=now+540', async () => {
        assert.match(pair.privateKey, /BEGIN RSA PRIVATE KEY/);
        const nowMs = 1_800_000_000_000;
        const jwt = await signAppJwt({ appId: '4321', privateKey: pair.privateKey }, nowMs);
        const { payload, protectedHeader } = await jwtVerify(jwt, await importSPKI(pair.publicKey, 'RS256'), {
            issuer: '4321',
            currentDate: new Date(nowMs)
        });
        assert.equal(protectedHeader.alg, 'RS256');
        assert.equal(payload.iat, nowMs / 1000 - 60);
        assert.equal(payload.exp, nowMs / 1000 + 540);
    });

    it('also accepts PKCS#8 keys', async () => {
        const p8 = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' }
        });
        const jwt = await signAppJwt({ appId: '1', privateKey: p8.privateKey });
        await jwtVerify(jwt, await importSPKI(p8.publicKey, 'RS256'), { issuer: '1' });
    });

    it('requires credentials', async () => {
        await assert.rejects(() => signAppJwt({}), /not configured/);
    });
});
