import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { Resolver } from 'node:dns/promises';
import { Agent, request as httpsRequest } from 'node:https';
import { BlockList, isIP, Socket } from 'node:net';

/*
 * An SSRF-hardened GET for fetching a client-chosen https URL. Node core `https` is used deliberately: axios follows redirects and
 * honours *_PROXY, and global fetch can't pin a connection to a vetted address.
 *
 * The host is resolved once, every resulting address must be public, and the connection is pinned to exactly those addresses (no
 * second resolution), with SNI and certificate verification against the hostname. No redirects, no cookies, no compression, a
 * streaming size cap and one deadline over the whole exchange.
 */

export type ClientMetadataFetchErrorKind =
    | 'dns'
    | 'timeout'
    | 'connect'
    | 'tls'
    | 'http_5xx'
    | 'http_429'
    | 'blocked_address'
    | 'http_status'
    | 'content_type'
    | 'encoding'
    | 'too_large'
    | 'invalid_json'
    | 'rate_limited';

const TRANSIENT_KINDS: ReadonlySet<ClientMetadataFetchErrorKind> = new Set([
    'dns',
    'timeout',
    'connect',
    'tls',
    'http_5xx',
    'http_429',
    'rate_limited'
]);

/** A failed fetch. `transient` failures (the publisher may be briefly down) are told apart from definitive ones (the answer is no). */
export class ClientMetadataFetchError extends Error {
    readonly transient: boolean;

    constructor(readonly kind: ClientMetadataFetchErrorKind) {
        super(`client metadata fetch failed: ${kind}`);
        this.transient = TRANSIENT_KINDS.has(kind);
    }
}

// ------------------------------------------------------------------------------------------------------------ address policy

const BLOCKED_V4: [string, number][] = [
    ['0.0.0.0', 8], // "this network"
    ['10.0.0.0', 8],
    ['100.64.0.0', 10], // CGNAT (also Alibaba metadata 100.100.100.200)
    ['127.0.0.0', 8],
    ['169.254.0.0', 16], // link-local, cloud metadata
    ['172.16.0.0', 12],
    ['192.0.0.0', 24], // IETF protocol assignments (Oracle metadata 192.0.0.192)
    ['192.0.2.0', 24], // documentation
    ['192.88.99.0', 24], // 6to4 relay
    ['192.168.0.0', 16],
    ['198.18.0.0', 15], // benchmarking
    ['198.51.100.0', 24], // documentation
    ['203.0.113.0', 24], // documentation
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4] // reserved, broadcast
];

/** Inside 2000::/3 (global unicast), the parts that are not globally routable or that embed other addresses. */
const BLOCKED_V6: [string, number][] = [
    ['2001::', 23], // IETF protocol assignments, Teredo
    ['2001:db8::', 32], // documentation
    ['2002::', 16], // 6to4
    ['3fff::', 20] // documentation
];

const v4List = new BlockList();
for (const [net, prefix] of BLOCKED_V4) v4List.addSubnet(net, prefix, 'ipv4');
const v6Blocked = new BlockList();
for (const [net, prefix] of BLOCKED_V6) v6Blocked.addSubnet(net, prefix, 'ipv6');
const v6GlobalUnicast = new BlockList();
v6GlobalUnicast.addSubnet('2000::', 3, 'ipv6');

/**
 * Whether `ip` is a publicly routable unicast address. IPv6 is allow-listed (global unicast 2000::/3 minus the exceptions above),
 * which excludes by construction `::`, `::1`, IPv4-mapped and -compatible forms, NAT64, ULA (fc00::/7), link-local and multicast.
 */
export function isPublicAddress(ip: string): boolean {
    if (typeof ip !== 'string' || ip.includes('%')) return false;
    const family = isIP(ip);
    if (family === 4) return !v4List.check(ip, 'ipv4');
    if (family === 6) return v6GlobalUnicast.check(ip, 'ipv6') && !v6Blocked.check(ip, 'ipv6');
    return false;
}

// ------------------------------------------------------------------------------------------------------------------- fetcher

export interface IResolvedAddress {
    address: string;
    family: number;
}

/** Test seams: production code never passes these. */
export interface ISafeFetchOptions {
    /** Resolves a host. The signal aborts at the deadline: an implementation must stop its work then. */
    resolve?: (host: string, signal: AbortSignal) => Promise<IResolvedAddress[]>;
    isAllowedAddress?: (ip: string) => boolean;
    ca?: string | Buffer;
    connectPort?: number;
    timeoutMs?: number;
    maxBytes?: number;
}

export interface ISafeFetchResult {
    json: unknown;
    cacheControl?: string;
}

export const SAFE_FETCH_TIMEOUT_MS = 3000;
export const SAFE_FETCH_MAX_BYTES = 5120;

/**
 * Resolution through c-ares (an explicit Resolver) rather than dns.lookup: lookup runs on the libuv thread pool and cannot be
 * cancelled, so a slow-DNS domain could stall every other lookup in the process. This skips /etc/hosts, which is fine here (loopback
 * is blocked anyway). Both families are asked for; one of them having no records is normal.
 */
function createDefaultResolve(timeoutMs: number) {
    return async (host: string, signal: AbortSignal): Promise<IResolvedAddress[]> => {
        const resolver = new Resolver({ timeout: Math.max(250, timeoutMs), tries: 1 });
        const cancel = () => resolver.cancel();
        signal.addEventListener('abort', cancel, { once: true });
        try {
            const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
            const out: IResolvedAddress[] = [];
            if (v4.status === 'fulfilled') out.push(...v4.value.map(address => ({ address, family: 4 })));
            if (v6.status === 'fulfilled') out.push(...v6.value.map(address => ({ address, family: 6 })));
            if (!out.length) throw new Error('no addresses');
            return out;
        } finally {
            signal.removeEventListener('abort', cancel);
            resolver.cancel();
        }
    };
}

const TLS_ERROR_CODES = new Set([
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'ERR_TLS_HANDSHAKE_TIMEOUT'
]);

function classify(err: unknown, timedOut: boolean): ClientMetadataFetchError {
    if (err instanceof ClientMetadataFetchError) return err;
    if (timedOut) return new ClientMetadataFetchError('timeout');
    const code = String((err as { code?: unknown })?.code ?? '');
    if (TLS_ERROR_CODES.has(code) || code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS') || code.startsWith('ERR_OSSL')) {
        return new ClientMetadataFetchError('tls');
    }
    return new ClientMetadataFetchError('connect');
}

/**
 * GETs `url` (https, no query) and parses the body as JSON. Throws ClientMetadataFetchError for every failure. Only status 200 is
 * success; redirects are never followed.
 */
export async function safeHttpsGetJson(url: URL, opts: ISafeFetchOptions = {}): Promise<ISafeFetchResult> {
    const timeoutMs = opts.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? SAFE_FETCH_MAX_BYTES;
    const resolve = opts.resolve ?? createDefaultResolve(timeoutMs);
    const isAllowed = opts.isAllowedAddress ?? isPublicAddress;

    if (url.protocol !== 'https:') throw new ClientMetadataFetchError('connect');
    const host = url.hostname;

    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
    }, timeoutMs);
    timer.unref?.();
    // One deadline over the whole exchange: everything awaited below is raced against it.
    const deadline = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new ClientMetadataFetchError('timeout'))));
    deadline.catch(() => undefined);

    try {
        let addresses: IResolvedAddress[];
        try {
            addresses = await Promise.race([resolve(host, abort.signal), deadline]);
        } catch (err) {
            throw err instanceof ClientMetadataFetchError ? err : new ClientMetadataFetchError('dns');
        }
        if (!addresses.length) throw new ClientMetadataFetchError('dns');
        // One private answer among public ones is a rebinding tell: refuse the lot.
        if (!addresses.every(a => isAllowed(a.address))) throw new ClientMetadataFetchError('blocked_address');
        const pinned = addresses.map(a => ({ address: a.address, family: a.family }));

        const exchange = new Promise<ISafeFetchResult>((resolveFetch, rejectFetch) => {
            const agent = new Agent({ keepAlive: false });
            let req: ReturnType<typeof httpsRequest> | undefined;
            let socketRef: Socket | undefined;
            let responded = false;
            const teardown = () => {
                socketRef?.destroy();
                req?.destroy();
            };
            // The first outcome wins; the transport is always torn down, so no outcome can leave a socket (or the promise) hanging.
            const fail = (err: ClientMetadataFetchError) => {
                rejectFetch(err);
                teardown();
            };
            abort.signal.addEventListener('abort', teardown, { once: true });

            // Tracing suppressed: the request must carry no traceparent or baggage (nothing identifying leaves with it).
            req = context.with(suppressTracing(context.active()), () =>
                httpsRequest(
                    {
                        agent,
                        host,
                        port: opts.connectPort ?? 443,
                        path: url.pathname,
                        method: 'GET',
                        servername: host,
                        ca: opts.ca,
                        minVersion: 'TLSv1.2',
                        rejectUnauthorized: true,
                        signal: abort.signal,
                        headers: {
                            Host: host,
                            Accept: 'application/json',
                            'Accept-Encoding': 'identity',
                            'User-Agent': 'PixelCI-OAuth',
                            Connection: 'close'
                        },
                        // The connection can only go to an address vetted above; there is no second resolution.
                        lookup: ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) =>
                            options?.all ? cb(null, pinned) : cb(null, pinned[0].address, pinned[0].family)) as never
                    },
                    res => {
                        responded = true;
                        const status = res.statusCode ?? 0;
                        if (status !== 200)
                            return fail(
                                new ClientMetadataFetchError(status >= 500 && status < 600 ? 'http_5xx' : status === 429 ? 'http_429' : 'http_status')
                            );

                        const mediaType = String(res.headers['content-type'] ?? '')
                            .split(';')[0]
                            .trim()
                            .toLowerCase();
                        if (mediaType !== 'application/json' && !/^application\/[a-z0-9!#$&^_.-]+\+json$/.test(mediaType)) {
                            return fail(new ClientMetadataFetchError('content_type'));
                        }
                        const encoding = String(res.headers['content-encoding'] ?? 'identity')
                            .trim()
                            .toLowerCase();
                        if (encoding !== 'identity') return fail(new ClientMetadataFetchError('encoding'));
                        const length = res.headers['content-length'];
                        if (length !== undefined && !(Number(length) <= maxBytes)) return fail(new ClientMetadataFetchError('too_large'));

                        const chunks: Buffer[] = [];
                        let total = 0;
                        res.on('data', (chunk: Buffer) => {
                            total += chunk.length;
                            if (total > maxBytes) return fail(new ClientMetadataFetchError('too_large'));
                            chunks.push(chunk);
                        });
                        res.on('error', err => fail(classify(err, timedOut)));
                        res.on('aborted', () => fail(classify(undefined, timedOut)));
                        res.on('end', () => {
                            try {
                                // TextDecoder strips a leading BOM by default.
                                const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
                                resolveFetch({ json: JSON.parse(text), cacheControl: res.headers['cache-control'] });
                            } catch {
                                rejectFetch(new ClientMetadataFetchError('invalid_json'));
                            }
                        });
                        // A body that ends without 'end' (connection closed early) must still settle.
                        res.on('close', () => fail(new ClientMetadataFetchError('connect')));
                    }
                )
            );
            req.on('error', err => fail(classify(err, timedOut)));
            // 101 and CONNECT-style upgrades never reach the response callback: refuse them outright.
            req.on('upgrade', (_res, socket) => {
                socket.destroy();
                fail(new ClientMetadataFetchError('http_status'));
            });
            req.on('connect', (_res, socket) => {
                socket.destroy();
                fail(new ClientMetadataFetchError('http_status'));
            });
            // The request closing before any response (peer hung up, or 1xx handling) is a failed exchange.
            req.on('close', () => {
                agent.destroy();
                if (!responded) fail(new ClientMetadataFetchError('connect'));
            });
            // Belt and braces: whatever the socket actually connected to must still be public.
            req.on('socket', (socket: Socket) => {
                socketRef = socket;
                const check = () => {
                    if (!socket.remoteAddress || !isAllowed(socket.remoteAddress)) fail(new ClientMetadataFetchError('blocked_address'));
                };
                if (socket.connecting) socket.once('connect', check);
                else check();
            });
            req.end();
        });
        exchange.catch(() => undefined);
        return await Promise.race([exchange, deadline]);
    } catch (err) {
        throw classify(err, timedOut);
    } finally {
        clearTimeout(timer);
        abort.abort();
    }
}
