import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, Server } from 'node:https';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createServer as createTlsServer } from 'node:tls';
import { gzipSync } from 'node:zlib';

import { ClientMetadataFetchError, ISafeFetchOptions, isPublicAddress, safeHttpsGetJson } from '../../src/services/oauth/SafeHttpsFetch';

describe('isPublicAddress', () => {
    it('denies every special-use range', () => {
        for (const ip of [
            '0.0.0.0',
            '0.1.2.3',
            '10.0.0.1',
            '10.255.255.255',
            '100.64.0.1',
            '100.100.100.200',
            '127.0.0.1',
            '127.255.255.254',
            '169.254.169.254',
            '172.16.0.1',
            '172.31.255.255',
            '192.0.0.1',
            '192.0.0.192',
            '192.0.2.1',
            '192.88.99.1',
            '192.168.1.1',
            '198.18.0.1',
            '198.19.255.255',
            '198.51.100.1',
            '203.0.113.1',
            '224.0.0.1',
            '239.255.255.255',
            '240.0.0.1',
            '255.255.255.255',
            '::',
            '::1',
            '::ffff:127.0.0.1',
            '::ffff:7f00:1',
            '::ffff:8.8.8.8',
            '::127.0.0.1',
            '64:ff9b::a00:1',
            '64:ff9b::808:808',
            '64:ff9b:1::1',
            '100::1',
            '2001::1',
            '2001:1::1',
            '2001:db8::1',
            '2002:7f00:1::1',
            '2002:808:808::1',
            '3fff::1',
            'fc00::1',
            'fd00:ec2::254',
            'fe80::1',
            'fe80::1%eth0',
            'fec0::1',
            'ff02::1',
            'not an ip',
            '',
            '1.1.1.1/24'
        ]) {
            assert.equal(isPublicAddress(ip), false, ip);
        }
    });

    it('allows public unicast addresses', () => {
        for (const ip of [
            '1.1.1.1',
            '8.8.8.8',
            '93.184.216.34',
            '172.32.0.1',
            '100.63.255.255',
            '100.128.0.1',
            '2606:4700:4700::1111',
            '2a00:1450:4001::200e'
        ]) {
            assert.equal(isPublicAddress(ip), true, ip);
        }
    });
});

// Tests run from the compiled output, so the fixture is located from the package root (the working directory).
const DIR = join(process.cwd(), 'tests', 'fixtures', 'cimd-tls');
const HOST = 'cimd.test';

describe('safeHttpsGetJson', () => {
    let server: Server;
    let port: number;
    let connections = 0;
    const remotes: string[] = [];
    const hits: string[] = [];
    const cert = readFileSync(join(DIR, 'cert.pem'));

    before(async () => {
        server = createServer({ key: readFileSync(join(DIR, 'key.pem')), cert }, (req, res) => {
            hits.push(req.url ?? '');
            const json = (body: string, headers: Record<string, string> = {}) => {
                res.writeHead(200, { 'content-type': 'application/json', ...headers });
                res.end(body);
            };
            switch (req.url) {
                case '/ok':
                    return json('{"a":1}', { 'cache-control': 'max-age=60' });
                case '/bom':
                    return json('﻿{"a":2}');
                case '/ld':
                    res.writeHead(200, { 'content-type': 'application/ld+json; charset=utf-8' });
                    return res.end('{"a":3}');
                case '/redirect':
                    res.writeHead(302, { location: '/ok' });
                    return res.end();
                case '/404':
                    res.writeHead(404, { 'content-type': 'application/json' });
                    return res.end('{}');
                case '/429':
                    res.writeHead(429, { 'content-type': 'application/json' });
                    return res.end('{}');
                case '/500':
                    res.writeHead(503, { 'content-type': 'application/json' });
                    return res.end('{}');
                case '/big-length':
                    return json('{"a":"' + 'x'.repeat(6000) + '"}');
                case '/big-chunked':
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.write('{"a":"');
                    for (let i = 0; i < 20; i++) res.write('x'.repeat(1000));
                    return res.end('"}');
                case '/html':
                    res.writeHead(200, { 'content-type': 'text/html' });
                    return res.end('{}');
                case '/gzip':
                    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
                    return res.end(gzipSync('{"a":1}'));
                case '/bad-json':
                    return json('{nope');
                case '/slow':
                    setTimeout(() => json('{"a":1}'), 2000).unref();
                    return;
                default:
                    res.writeHead(404);
                    res.end();
            }
        });
        server.on('connection', socket => {
            connections++;
            remotes.push(socket.remoteAddress ?? '');
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as AddressInfo).port;
    });

    after(() => {
        server.closeAllConnections();
        server.close();
    });

    const fetchOpts = (over: ISafeFetchOptions = {}): ISafeFetchOptions => ({
        ca: cert,
        connectPort: port,
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
        isAllowedAddress: () => true,
        ...over
    });
    const get = (path: string, over?: ISafeFetchOptions, host = HOST) => safeHttpsGetJson(new URL('https://' + host + path), fetchOpts(over));
    const kindOf = async (p: Promise<unknown>) => {
        try {
            await p;
        } catch (err) {
            assert.ok(err instanceof ClientMetadataFetchError, String(err));
            return { kind: err.kind, transient: err.transient };
        }
        return assert.fail('expected a failure');
    };

    it('fetches JSON and reports Cache-Control', async () => {
        assert.deepEqual(await get('/ok'), { json: { a: 1 }, cacheControl: 'max-age=60' });
    });

    it('strips a BOM and accepts +json media types', async () => {
        assert.deepEqual((await get('/bom')).json, { a: 2 });
        assert.deepEqual((await get('/ld')).json, { a: 3 });
    });

    it('does not follow redirects', async () => {
        hits.length = 0;
        assert.deepEqual(await kindOf(get('/redirect')), { kind: 'http_status', transient: false });
        assert.deepEqual(hits, ['/redirect']);
    });

    it('classifies HTTP statuses', async () => {
        assert.deepEqual(await kindOf(get('/404')), { kind: 'http_status', transient: false });
        assert.deepEqual(await kindOf(get('/500')), { kind: 'http_5xx', transient: true });
        assert.deepEqual(await kindOf(get('/429')), { kind: 'http_429', transient: true });
    });

    it('caps the body, by header and while streaming', async () => {
        assert.deepEqual(await kindOf(get('/big-length')), { kind: 'too_large', transient: false });
        assert.deepEqual(await kindOf(get('/big-chunked')), { kind: 'too_large', transient: false });
    });

    it('rejects wrong content type, encoding and malformed JSON', async () => {
        assert.deepEqual(await kindOf(get('/html')), { kind: 'content_type', transient: false });
        assert.deepEqual(await kindOf(get('/gzip')), { kind: 'encoding', transient: false });
        assert.deepEqual(await kindOf(get('/bad-json')), { kind: 'invalid_json', transient: false });
    });

    it('times out over the whole exchange', async () => {
        assert.deepEqual(await kindOf(get('/slow', { timeoutMs: 400 })), { kind: 'timeout', transient: true });
    });

    it('verifies the certificate against the hostname and the trust store', async () => {
        assert.deepEqual(await kindOf(get('/ok', {}, 'other.test')), { kind: 'tls', transient: true });
        assert.deepEqual(await kindOf(get('/ok', { ca: undefined })), { kind: 'tls', transient: true });
    });

    it('refuses a private address before connecting', async () => {
        const before = connections;
        const err = await kindOf(
            safeHttpsGetJson(new URL('https://' + HOST + '/ok'), { connectPort: port, resolve: async () => [{ address: '127.0.0.1', family: 4 }] })
        );
        assert.deepEqual(err, { kind: 'blocked_address', transient: false });
        assert.equal(connections, before);
    });

    it('refuses mixed public and private records', async () => {
        const before = connections;
        const err = await kindOf(
            safeHttpsGetJson(new URL('https://' + HOST + '/ok'), {
                connectPort: port,
                resolve: async () => [
                    { address: '1.1.1.1', family: 4 },
                    { address: '10.0.0.1', family: 4 }
                ]
            })
        );
        assert.equal(err.kind, 'blocked_address');
        assert.equal(connections, before);
    });

    it('resolves once and connects only to the vetted address', async () => {
        let calls = 0;
        const resolve = async () => {
            calls++;
            return calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.9.9.9', family: 4 }];
        };
        remotes.length = 0;
        await get('/ok', { resolve });
        assert.equal(calls, 1);
        assert.deepEqual(remotes, ['127.0.0.1']);
    });

    it('reports resolution failures as transient', async () => {
        assert.deepEqual(await kindOf(get('/ok', { resolve: async () => [] })), { kind: 'dns', transient: true });
        assert.deepEqual(await kindOf(get('/ok', { resolve: () => Promise.reject(new Error('ENOTFOUND')) })), { kind: 'dns', transient: true });
    });

    it('reports a refused connection as transient', async () => {
        assert.deepEqual(await kindOf(get('/ok', { connectPort: 1 })), { kind: 'connect', transient: true });
    });

    /** A raw TLS server whose behaviour per connection is up to the test. */
    const rawServer = async (onConnection: (socket: import('node:tls').TLSSocket) => void) => {
        const raw = createTlsServer({ key: readFileSync(join(DIR, 'key.pem')), cert }, onConnection);
        await new Promise<void>(resolve => raw.listen(0, '127.0.0.1', resolve));
        return { port: (raw.address() as AddressInfo).port, close: () => raw.close() };
    };

    it('refuses a 101 Switching Protocols answer promptly, with or without the peer hanging up', async () => {
        for (const hangUp of [true, false]) {
            const raw = await rawServer(socket => {
                socket.once('data', () => {
                    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n');
                    if (hangUp) setTimeout(() => socket.end(), 30);
                });
            });
            const started = Date.now();
            try {
                assert.deepEqual(await kindOf(get('/x', { connectPort: raw.port, timeoutMs: 1500 })), { kind: 'http_status', transient: false });
                assert.ok(Date.now() - started < 1400, 'settled well before the deadline');
            } finally {
                raw.close();
            }
        }
    });

    it('fails when the peer closes the connection without answering', async () => {
        const raw = await rawServer(socket => socket.once('data', () => socket.destroy()));
        try {
            const started = Date.now();
            assert.deepEqual(await kindOf(get('/x', { connectPort: raw.port, timeoutMs: 1500 })), { kind: 'connect', transient: true });
            assert.ok(Date.now() - started < 1400);
        } finally {
            raw.close();
        }
    });

    it('fails when the peer closes mid-body', async () => {
        const raw = await rawServer(socket =>
            socket.once('data', () => {
                socket.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"a":');
                setTimeout(() => socket.destroy(), 30);
            })
        );
        try {
            const err = await kindOf(get('/x', { connectPort: raw.port, timeoutMs: 1500 }));
            assert.equal(err.transient, true);
        } finally {
            raw.close();
        }
    });

    it('times out a peer that never answers, even a hung one', async () => {
        const raw = await rawServer(socket => socket.once('data', () => undefined));
        try {
            assert.deepEqual(await kindOf(get('/x', { connectPort: raw.port, timeoutMs: 300 })), { kind: 'timeout', transient: true });
        } finally {
            raw.close();
        }
    });

    it('gives the resolver an abort signal and does not wait for one that ignores it', async () => {
        let aborted = false;
        const started = Date.now();
        const err = await kindOf(
            get('/ok', {
                timeoutMs: 300,
                resolve: (_host, signal) => {
                    signal.addEventListener('abort', () => (aborted = true));
                    return new Promise(() => undefined);
                }
            })
        );
        assert.deepEqual(err, { kind: 'timeout', transient: true });
        assert.ok(Date.now() - started < 1000);
        assert.equal(aborted, true);
    });
});
