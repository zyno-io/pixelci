import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { tmpdir } from 'os';
import { join } from 'path';

import { getGitHubCiInfo, reportGitHubResult } from './ci-github.js';

describe('GitHub Actions CI', () => {
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    let fetchCalls: { url: string; init?: RequestInit }[];
    let logs: string[];
    let tmp: string;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.GITHUB_ACTIONS;
        delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
        delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
        delete process.env.GITHUB_SERVER_URL;
        delete process.env.GITHUB_REPOSITORY;
        delete process.env.GITHUB_STEP_SUMMARY;
        fetchCalls = [];
        logs = [];
        console.log = (...args: unknown[]) => void logs.push(args.join(' '));
        tmp = mkdtempSync(join(tmpdir(), 'pixelci-gha-'));
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
            fetchCalls.push({ url: String(url), init });
            return new Response(JSON.stringify({ value: 'oidc-jwt' }), { status: 200 });
        }) as typeof fetch;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
        globalThis.fetch = originalFetch;
        console.log = originalLog;
        rmSync(tmp, { recursive: true, force: true });
    });

    function setActionsEnv(requestUrl = 'https://actions.example/token') {
        process.env.GITHUB_ACTIONS = 'true';
        process.env.ACTIONS_ID_TOKEN_REQUEST_URL = requestUrl;
        process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'req-token';
        process.env.GITHUB_REPOSITORY = 'acme/app';
    }

    it('returns null outside GitHub Actions', async () => {
        assert.equal(await getGitHubCiInfo('https://pixelci.test'), null);
        assert.equal(fetchCalls.length, 0);
    });

    it('throws when the id-token env is missing', async () => {
        process.env.GITHUB_ACTIONS = 'true';
        await assert.rejects(() => getGitHubCiInfo('aud'), /id-token: write/);
    });

    it('requests the token with audience and bearer header (no query string)', async () => {
        setActionsEnv();
        const info = await getGitHubCiInfo('https://pixelci.test');
        assert.equal(fetchCalls[0].url, 'https://actions.example/token?audience=https%3A%2F%2Fpixelci.test');
        assert.deepStrictEqual(fetchCalls[0].init?.headers, { Authorization: 'Bearer req-token' });
        assert.deepStrictEqual(info, { projectUrl: 'https://github.com/acme/app', ciToken: 'oidc-jwt' });
    });

    it('appends audience with & when the URL already has a query', async () => {
        setActionsEnv('https://actions.example/token?api-version=2.0');
        await getGitHubCiInfo('https://pixelci.test');
        assert.equal(fetchCalls[0].url, 'https://actions.example/token?api-version=2.0&audience=https%3A%2F%2Fpixelci.test');
    });

    it('uses GITHUB_SERVER_URL for the project URL (GHES)', async () => {
        setActionsEnv();
        process.env.GITHUB_SERVER_URL = 'https://ghe.example.com';
        const info = await getGitHubCiInfo('aud');
        assert.equal(info?.projectUrl, 'https://ghe.example.com/acme/app');
    });

    it('throws on non-OK or tokenless responses', async () => {
        setActionsEnv();
        globalThis.fetch = (async () => new Response('nope', { status: 403, statusText: 'Forbidden' })) as typeof fetch;
        await assert.rejects(() => getGitHubCiInfo('aud'), /403/);
        globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
        await assert.rejects(() => getGitHubCiInfo('aud'), /did not include a token/);
    });

    it('reportGitHubResult is a no-op outside Actions', () => {
        process.env.GITHUB_STEP_SUMMARY = join(tmp, 'summary.md');
        reportGitHubResult('needs review', 'https://x/y');
        assert.deepStrictEqual(logs, []);
        assert.equal(existsSync(join(tmp, 'summary.md')), false);
    });

    it('emits an error annotation and summary for needs review', () => {
        process.env.GITHUB_ACTIONS = 'true';
        const summary = join(tmp, 'summary.md');
        process.env.GITHUB_STEP_SUMMARY = summary;
        reportGitHubResult('needs review', 'https://pixelci.test/apps/a/builds/b');
        assert.equal(logs.length, 1);
        assert.match(logs[0], /^::error title=PixelCI::.*https:\/\/pixelci\.test\/apps\/a\/builds\/b$/);
        const text = readFileSync(summary, 'utf8');
        assert.match(text, /needs review/);
        assert.match(text, /https:\/\/pixelci\.test\/apps\/a\/builds\/b/);
    });

    it('escapes %, CR and LF in annotation messages', () => {
        process.env.GITHUB_ACTIONS = 'true';
        reportGitHubResult('failed', 'https://x/100%\r\nfoo');
        assert.match(logs[0], /100%25%0D%0Afoo$/);
        assert.equal(logs[0].includes('\n'), false);
    });

    it('writes only a summary (no annotation) for passing statuses', () => {
        process.env.GITHUB_ACTIONS = 'true';
        const summary = join(tmp, 'summary.md');
        process.env.GITHUB_STEP_SUMMARY = summary;
        reportGitHubResult('no changes', 'https://x/y');
        assert.deepStrictEqual(logs, []);
        assert.match(readFileSync(summary, 'utf8'), /no changes/);
    });
});
