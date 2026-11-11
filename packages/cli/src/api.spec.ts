import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock, beforeEach, after, afterEach } from 'node:test';

import { PixelCiApi, backoffMs, getApi } from './api.js';
import { AppError } from './error.js';

const mockFetch = mock.fn<typeof globalThis.fetch>();
globalThis.fetch = mockFetch;

describe('getApi', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env = { ...originalEnv };
        mockFetch.mock.resetCalls();
    });

    after(() => {
        process.env = originalEnv;
    });

    const jobInfo = {
        projectUrl: 'https://gitlab.com/test/project',
        ciToken: 'glcbt-test-token'
    };

    it('should create API instance when both env vars are set', () => {
        process.env.PIXELCI_API_URL = 'http://localhost:7924';
        process.env.PIXELCI_APP_ID = 'test-app-id';

        const api = getApi(jobInfo);

        assert.ok(api instanceof PixelCiApi);
    });

    it('should throw error when PIXELCI_API_URL is missing', () => {
        delete process.env.PIXELCI_API_URL;
        process.env.PIXELCI_APP_ID = 'test-app-id';

        assert.throws(
            () => getApi(jobInfo),
            (err: any) => {
                assert.ok(err instanceof AppError);
                assert.equal(err.message, 'PIXELCI_API_URL environment variable is not set');
                return true;
            }
        );
    });

    it('should throw error when PIXELCI_APP_ID is missing', () => {
        process.env.PIXELCI_API_URL = 'http://localhost:7924';
        delete process.env.PIXELCI_APP_ID;

        assert.throws(
            () => getApi(jobInfo),
            (err: any) => {
                assert.ok(err instanceof AppError);
                assert.equal(err.message, 'PIXELCI_APP_ID environment variable is not set');
                return true;
            }
        );
    });
});

describe('PixelCiApi', () => {
    let api: PixelCiApi;

    beforeEach(() => {
        mockFetch.mock.resetCalls();
        api = new PixelCiApi('http://localhost:7924/', 'test-app-id', {
            projectUrl: 'https://gitlab.com/test/project',
            ciToken: 'glcbt-test-token'
        });
    });

    describe('constructor', () => {
        it('should remove trailing slashes from server URL', () => {
            const api1 = new PixelCiApi('http://localhost:7924///', 'test-app-id', {
                projectUrl: 'https://gitlab.com/test/project',
                ciToken: 'glcbt-test-token'
            });
            assert.equal(api1.getBuildUserUrl('build-123'), 'http://localhost:7924/apps/test-app-id/builds/build-123');
        });
    });

    describe('createBuild', () => {
        it('should create a build with projectUrl in body', async () => {
            const mockResponse = {
                id: 'build-123',
                status: 'draft' as const
            };

            mockFetch.mock.mockImplementation(
                async () =>
                    ({
                        ok: true,
                        json: async () => mockResponse
                    }) as any
            );

            const result = await api.createBuild({ screens: { count: 1, hash: 'h' } });

            assert.deepStrictEqual(result, {
                buildId: 'build-123',
                status: 'draft',
                shard: undefined
            });

            assert.equal(mockFetch.mock.callCount(), 1);
            const [url, options] = mockFetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:7924/api/apps/test-app-id/builds');
            assert.equal(options!.method, 'POST');
            assert.equal((options!.headers as Record<string, string>)['Authorization'], 'Bearer glcbt-test-token');
            assert.equal((options!.headers as Record<string, string>)['Content-Type'], 'application/json');

            const body = JSON.parse(options!.body as string);
            assert.equal(body.projectUrl, 'https://gitlab.com/test/project');
            assert.deepEqual(body.screens, { count: 1, hash: 'h' });
            assert.equal('shard' in body, false);
        });

        it('should send and return the shard', async () => {
            mockFetch.mock.mockImplementation(
                async () => ({ ok: true, json: async () => ({ id: 'b', status: 'draft', shard: { index: 2, total: 3 } }) }) as any
            );
            const result = await api.createBuild({ screens: { count: 0, hash: 'h' }, shard: { index: 2, total: 3 } });
            assert.deepEqual(result.shard, { index: 2, total: 3 });
            const body = JSON.parse(mockFetch.mock.calls[0].arguments[1]!.body as string);
            assert.deepEqual(body.shard, { index: 2, total: 3 });
        });

        it('should throw AppError on API failure', async () => {
            mockFetch.mock.mockImplementation(
                async () =>
                    ({
                        ok: false,
                        statusText: 'Bad Request',
                        text: async () => 'Invalid request'
                    }) as any
            );

            await assert.rejects(() => api.createBuild({ screens: { count: 1, hash: 'h' } }), AppError);
        });
    });

    describe('processBuild', () => {
        it('should process a build successfully', async () => {
            mockFetch.mock.mockImplementation(
                async () =>
                    ({
                        ok: true,
                        json: async () => ({ ok: true })
                    }) as any
            );

            await api.processBuild('build-123', { count: 2, hash: 'abc' });

            assert.equal(mockFetch.mock.callCount(), 1);
            const [url, options] = mockFetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:7924/api/apps/test-app-id/builds/build-123/process');
            assert.equal(options!.method, 'POST');
            assert.equal((options!.headers as Record<string, string>)['Authorization'], 'Bearer glcbt-test-token');
            assert.deepEqual(JSON.parse(options!.body as string), { screens: { count: 2, hash: 'abc' } });
        });
    });

    describe('getBuildStatus', () => {
        it('should get build status successfully', async () => {
            mockFetch.mock.mockImplementation(
                async () =>
                    ({
                        ok: true,
                        json: async () => ({ status: 'processing' })
                    }) as any
            );

            const status = await api.getBuildStatus('build-123');

            assert.equal(status, 'processing');
            assert.equal(mockFetch.mock.callCount(), 1);
            const [url, options] = mockFetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:7924/api/apps/test-app-id/builds/build-123/status');
            assert.equal(options!.method, 'GET');
            assert.equal((options!.headers as Record<string, string>)['Authorization'], 'Bearer glcbt-test-token');
        });
    });

    describe('getBuildUserUrl', () => {
        it('should generate correct build URL', () => {
            const url = api.getBuildUserUrl('build-123');
            assert.equal(url, 'http://localhost:7924/apps/test-app-id/builds/build-123');
        });
    });
});

describe('request retries', () => {
    let api: PixelCiApi;
    const ok = (data: unknown = { status: 'processing' }) => ({ ok: true, status: 200, json: async () => data }) as any;
    const fail = (status: number, text = 'nope', headers: Record<string, string> = {}) =>
        ({ ok: false, status, statusText: 'x', text: async () => text, headers: new Headers(headers) }) as any;

    // advances fake timers until the promise settles
    async function run<T>(p: Promise<T>): Promise<T> {
        let done = false;
        const wrapped = p.finally(() => (done = true));
        wrapped.catch(() => {});
        while (!done) {
            await new Promise(resolve => setImmediate(resolve));
            mock.timers.tick(1000);
        }
        return wrapped;
    }

    beforeEach(() => {
        mockFetch.mock.resetCalls();
        mock.timers.enable({ apis: ['setTimeout'] });
        mock.method(console, 'warn', () => {});
        api = new PixelCiApi('http://localhost:7924', 'app', { projectUrl: 'p', ciToken: 't' });
    });

    afterEach(() => {
        mock.timers.reset();
        mock.restoreAll();
    });

    it('retries network errors', async () => {
        let n = 0;
        mockFetch.mock.mockImplementation(async () => {
            if (++n < 3) throw new TypeError('fetch failed');
            return ok();
        });
        assert.equal(await run(api.getBuildStatus('b')), 'processing');
        assert.equal(n, 3);
    });

    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
        it(`retries HTTP ${status}`, async () => {
            let n = 0;
            mockFetch.mock.mockImplementation(async () => (++n < 2 ? fail(status) : ok()));
            await run(api.getBuildStatus('b'));
            assert.equal(n, 2);
        });
    }

    for (const status of [400, 401, 403, 404, 409]) {
        it(`does not retry HTTP ${status} and surfaces the message`, async () => {
            mockFetch.mock.mockImplementation(async () => fail(status, JSON.stringify({ message: 'the reason' })));
            await assert.rejects(
                () => run(api.getBuildStatus('b')),
                (err: any) => err instanceof AppError && err.message.includes('the reason') && err.message.includes(String(status))
            );
            assert.equal(mockFetch.mock.callCount(), 1);
        });
    }

    it('gives up after 7 attempts', async () => {
        mockFetch.mock.mockImplementation(async () => fail(503));
        await assert.rejects(() => run(api.getBuildStatus('b')), AppError);
        assert.equal(mockFetch.mock.callCount(), 7);
    });

    it('follows the backoff schedule', () => {
        const mid = () => 0.5;
        assert.deepEqual(
            [1, 2, 3, 4, 5, 6].map(a => backoffMs(a, mid)),
            [1000, 2000, 4000, 8000, 16000, 30000]
        );
        assert.equal(
            backoffMs(1, () => 0),
            800
        );
        assert.equal(
            backoffMs(6, () => 1),
            36000
        );
    });

    it('waits the backoff delay between attempts', async () => {
        mock.method(Math, 'random', () => 0.5);
        let n = 0;
        mockFetch.mock.mockImplementation(async () => (++n < 3 ? fail(503) : ok()));
        const p = api.getBuildStatus('b');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(n, 1);
        mock.timers.tick(999);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(n, 1);
        mock.timers.tick(1);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(n, 2);
        mock.timers.tick(2000);
        await p;
        assert.equal(n, 3);
    });

    it('honours Retry-After, capped at 60s', async () => {
        let n = 0;
        mockFetch.mock.mockImplementation(async () => (++n < 3 ? fail(429, 'slow', { 'retry-after': n === 1 ? '5' : '3600' }) : ok()));
        const p = api.getBuildStatus('b');
        await new Promise(resolve => setImmediate(resolve));
        mock.timers.tick(4999);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(n, 1);
        mock.timers.tick(1);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(n, 2);
        mock.timers.tick(59_999);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(n, 2);
        mock.timers.tick(1);
        await p;
        assert.equal(n, 3);
    });

    it('passes an abort signal and retries a timeout', async () => {
        let n = 0;
        mockFetch.mock.mockImplementation(async (_url, init) => {
            assert.ok(init!.signal instanceof AbortSignal);
            if (++n < 2) throw new DOMException('timed out', 'TimeoutError');
            return ok();
        });
        await run(api.getBuildStatus('b'));
        assert.equal(n, 2);
    });

    it('rebuilds the upload body on every attempt', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'pixelci-cli-'));
        const file = join(dir, 'a.png');
        writeFileSync(file, 'png');
        const bodies: unknown[] = [];
        mockFetch.mock.mockImplementation(async (_url, init) => {
            bodies.push(init!.body);
            return bodies.length < 2 ? fail(502) : ok({ id: 'x' });
        });
        await run(api.uploadScreen('b', file, 'a'));
        assert.equal(bodies.length, 2);
        assert.ok(bodies[0] instanceof FormData && bodies[1] instanceof FormData);
        assert.notEqual(bodies[0], bodies[1]);
        rmSync(dir, { recursive: true });
    });
});
