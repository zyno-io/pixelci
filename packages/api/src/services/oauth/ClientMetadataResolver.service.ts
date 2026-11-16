import { ScopedLogger, sql, uuid4 } from '@zyno-io/ts-server-foundation';
import { createHash } from 'node:crypto';

import { AppConfig } from '../../config';
import { Db } from '../../database';
import { OAuthClientEntity } from '../../entities/OAuthClient.entity';
import { RateLimiterService } from '../RateLimiter.service';
import { cacheTtlSeconds, parseClientIdUrl, registrableDomain, validateClientMetadataDocument } from './ClientMetadata';
import { ClientMetadataFetcher } from './ClientMetadataFetcher';
import { getOAuthUrls, ipv6Groups } from './OAuthUrls';
import { ClientMetadataFetchError, ClientMetadataFetchErrorKind, ISafeFetchResult, SAFE_FETCH_TIMEOUT_MS } from './SafeHttpsFetch';

const TEN_MIN_S = 600;
const HOUR_S = 3600;
/** A stored document may stand in for a transiently failing refetch for this long after it was fetched. */
const STALE_IF_ERROR_MS = 24 * HOUR_S * 1000;

export type ResolveFailure = { ok: false; reason: 'invalid_client' | 'client_metadata_unavailable'; transient: boolean };
export type ResolveResult = { ok: true; client: OAuthClientEntity; stale: boolean } | ResolveFailure;

type Refreshed = { ok: true; client: OAuthClientEntity } | { ok: false; transient: boolean; kind: ClientMetadataFetchErrorKind | 'invalid_document' };

/** An IPv6 caller is bucketed by its /64 (a single host can take any address in it); IPv4 and IPv4-mapped addresses as they are. */
export function ipBucket(ip: string): string {
    const addr = ip.replace(/^::ffff:/i, '').split('%')[0];
    if (!addr.includes(':')) return addr;
    const groups = ipv6Groups(addr);
    return groups
        ? groups
              .slice(0, 4)
              .map(g => g.toString(16))
              .join(':') + '::/64'
        : addr;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Resolves URL client_ids (Client ID Metadata Documents) to stored clients, fetching and caching the document as needed. The cache
 * is the `oauth_clients` row, shared across replicas. Errors and invalid documents are never cached (draft section 6.2): refetch
 * load is bounded by rate limits (per URL, per host, overall) and by single-flight per pod instead.
 */
export class ClientMetadataResolver {
    private inflight = new Map<string, Promise<Refreshed>>();
    /** Backstop over whatever fetcher is installed: a hung implementation must never wedge the single-flight map. */
    fetchGuardMs = SAFE_FETCH_TIMEOUT_MS + 2000;

    constructor(
        private db: Db,
        private appConfig: AppConfig,
        private fetcher: ClientMetadataFetcher,
        private rateLimiter: RateLimiterService,
        private logger: ScopedLogger
    ) {}

    /** CIMD is effective only when OAuth itself is available. */
    isEnabled(): boolean {
        return this.appConfig.OAUTH_CIMD_ENABLED && getOAuthUrls(this.appConfig) !== null;
    }

    /** The stored client for a client_id URL, with no fetch and no freshness check. */
    async findStored(raw: string): Promise<OAuthClientEntity | undefined> {
        if (!this.isEnabled() || !parseClientIdUrl(raw).ok) return undefined;
        return OAuthClientEntity.query().filter({ metadataUrl: raw }).findOneOrUndefined();
    }

    /** Authorize path: the only place a never-seen URL is fetched. A transient failure may fall back to a recent stored document. */
    async resolveForAuthorize(raw: string, clientIp?: string): Promise<ResolveResult> {
        const parsed = parseClientIdUrl(raw);
        if (!this.isEnabled() || !parsed.ok) return { ok: false, reason: 'invalid_client', transient: false };

        const row = await this.findStored(raw);
        if (row && this.isFresh(row)) return { ok: true, client: row, stale: false };

        const refreshed = await this.refresh(raw, parsed.url, !!row, clientIp);
        if (refreshed.ok) return { ok: true, client: refreshed.client, stale: false };
        // Authorize is where redirect URIs are decided: a throttled refetch must not let an expired document stand in (a caller could
        // otherwise throttle itself to keep a since-changed document alive). Genuine network failures may.
        const stale = refreshed.kind === 'rate_limited' ? undefined : this.staleFallback(row, refreshed, parsed.url, raw);
        if (stale) return stale;
        return { ok: false, reason: 'client_metadata_unavailable', transient: refreshed.transient };
    }

    /**
     * Token path: only a URL that was already stored is considered (an unknown one never triggers a fetch). A document past its
     * expiry is refetched. A transient failure (including a throttled refetch) keeps serving the stored document within the stale
     * window, so existing clients are not broken by an outage or by someone burning fetch budget; only without a usable stored
     * document is it reported as transient (the caller answers 503). A definitive failure is `invalid_client`.
     */
    async resolveStored(raw: string, clientIp?: string): Promise<ResolveResult> {
        const parsed = parseClientIdUrl(raw);
        if (!this.isEnabled() || !parsed.ok) return { ok: false, reason: 'invalid_client', transient: false };
        const row = await this.findStored(raw);
        if (!row) return { ok: false, reason: 'invalid_client', transient: false };
        if (this.isFresh(row)) return { ok: true, client: row, stale: false };

        const refreshed = await this.refresh(raw, parsed.url, true, clientIp);
        if (refreshed.ok) return { ok: true, client: refreshed.client, stale: false };
        const stale = this.staleFallback(row, refreshed, parsed.url, raw);
        if (stale) return stale;
        return refreshed.transient
            ? { ok: false, reason: 'client_metadata_unavailable', transient: true }
            : { ok: false, reason: 'invalid_client', transient: false };
    }

    private isFresh(row: OAuthClientEntity): boolean {
        return !!row.metadataExpiresAt && row.metadataExpiresAt.getTime() > Date.now();
    }

    /**
     * A transient failure may be covered by the stored document if it was fetched within the stale window. A row whose last refetch
     * failed definitively has no fetch time (see markUnusable) and is never served.
     */
    private staleFallback(
        row: OAuthClientEntity | undefined,
        failure: Extract<Refreshed, { ok: false }>,
        url: URL,
        raw: string
    ): ResolveResult | undefined {
        if (!failure.transient || !row?.metadataFetchedAt || Date.now() - row.metadataFetchedAt.getTime() >= STALE_IF_ERROR_MS) return undefined;
        this.logger.warn('Using a stale client metadata document after a transient fetch failure', {
            host: url.hostname,
            urlHash: sha256(raw).slice(0, 16),
            kind: failure.kind
        });
        return { ok: true, client: row, stale: true };
    }

    /** One fetch per URL per pod at a time. */
    private refresh(raw: string, url: URL, stored: boolean, clientIp?: string): Promise<Refreshed> {
        let flight = this.inflight.get(raw);
        if (!flight) {
            flight = this.doRefresh(raw, url, stored, clientIp).finally(() => this.inflight.delete(raw));
            this.inflight.set(raw, flight);
        }
        return flight;
    }

    private async doRefresh(raw: string, url: URL, stored: boolean, clientIp?: string): Promise<Refreshed> {
        const urlHash = sha256(raw).slice(0, 16);
        const host = url.hostname;
        const failed = (transient: boolean, kind: ClientMetadataFetchErrorKind | 'invalid_document'): Refreshed => {
            // Never the full (attacker-chosen) URL.
            this.logger.info('Client metadata document unavailable', { host, urlHash, kind });
            return { ok: false, transient, kind };
        };

        // A refetch of an already-stored URL is charged only to the per-URL and per-registrable-domain stored buckets: those can't be
        // drained without a real fetch happening (the first attempt after expiry always fetches), so nobody can use up the budget
        // to stop a changed document being refetched. Unknown URLs are charged to the caller's IP first, then URL, domain and
        // overall; the per-host key is the registrable domain, so wildcard subdomains don't each get a fresh allowance.
        const registrable = registrableDomain(host);
        const limits: [string, number, number][] = [];
        if (stored) {
            limits.push(
                [`cimd:stored:url:${sha256(raw)}`, this.appConfig.OAUTH_CIMD_MAX_FETCHES_PER_URL_PER_10_MIN, TEN_MIN_S],
                [`cimd:stored:host:${registrable}`, this.appConfig.OAUTH_CIMD_MAX_FETCHES_PER_HOST_PER_10_MIN, TEN_MIN_S]
            );
        } else {
            if (clientIp) limits.push([`cimd:ip:${ipBucket(clientIp)}`, this.appConfig.OAUTH_CIMD_MAX_FETCHES_PER_IP_PER_10_MIN, TEN_MIN_S]);
            limits.push(
                [`cimd:url:${sha256(raw)}`, this.appConfig.OAUTH_CIMD_MAX_FETCHES_PER_URL_PER_10_MIN, TEN_MIN_S],
                [`cimd:host:${registrable}`, this.appConfig.OAUTH_CIMD_MAX_FETCHES_PER_HOST_PER_10_MIN, TEN_MIN_S],
                ['cimd:all', this.appConfig.OAUTH_CIMD_MAX_FETCHES_PER_HOUR, HOUR_S]
            );
        }
        for (const [key, max, window] of limits) {
            if (!(await this.rateLimiter.hit(key, max, window)).allowed) return failed(true, 'rate_limited');
        }

        let result: ISafeFetchResult;
        try {
            result = await this.guardedFetch(url);
        } catch (err) {
            if (err instanceof ClientMetadataFetchError) {
                if (!err.transient && stored) await this.markUnusable(raw);
                return failed(err.transient, err.kind);
            }
            this.logger.warn('Unexpected client metadata fetch error', { host, urlHash, error: err instanceof Error ? err.message : String(err) });
            return { ok: false, transient: true, kind: 'connect' };
        }

        const validation = validateClientMetadataDocument(result.json, raw);
        if (!validation.ok) {
            this.logger.info('Client metadata document rejected', { host, urlHash, reason: validation.reason });
            if (stored) await this.markUnusable(raw);
            return { ok: false, transient: false, kind: 'invalid_document' };
        }

        const now = new Date();
        const expiresAt = new Date(now.getTime() + cacheTtlSeconds(result.cacheControl) * 1000);
        // Atomic and replica-safe: a concurrent first fetch resolves to the same row (unique index on metadataUrl). Timestamps are
        // bound from JS because the columns hold naive UTC. createdAt and lastUsedAt are left alone on refetch.
        const row = await this.db.rawFindOne<{ id: string }>(sql`
            INSERT INTO "oauth_clients" ("id", "name", "redirectUris", "tokenEndpointAuthMethod", "secretHash", "createdAt", "lastUsedAt",
                                         "metadataUrl", "metadataFetchedAt", "metadataExpiresAt")
            VALUES (${uuid4()}, ${validation.name}, ${JSON.stringify(validation.redirectUris)}::json, 'none', NULL, ${now}, NULL,
                    ${raw}, ${now}, ${expiresAt})
            ON CONFLICT ("metadataUrl") DO UPDATE SET "name" = EXCLUDED."name", "redirectUris" = EXCLUDED."redirectUris",
                "metadataFetchedAt" = EXCLUDED."metadataFetchedAt", "metadataExpiresAt" = EXCLUDED."metadataExpiresAt"
            RETURNING "id"`);
        const client = row ? await OAuthClientEntity.query().filter({ id: row.id }).findOneOrUndefined() : undefined;
        if (!client) return { ok: false, transient: true, kind: 'connect' };
        return { ok: true, client };
    }

    /** The fetch under a deadline of our own, whatever the installed fetcher does. */
    private async guardedFetch(url: URL): Promise<ISafeFetchResult> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const guard = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ClientMetadataFetchError('timeout')), this.fetchGuardMs);
            timer.unref?.();
        });
        const fetching = this.fetcher.fetch(url);
        fetching.catch(() => undefined);
        try {
            return await Promise.race([fetching, guard]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * A definitive failure (document withdrawn or now invalid) must not be papered over by stale-if-error later, e.g. once a rate
     * limit trips. Clearing the fetch time makes the row unservable until a fetch succeeds again.
     */
    private async markUnusable(raw: string): Promise<void> {
        try {
            await OAuthClientEntity.query().filter({ metadataUrl: raw }).patchMany({ metadataFetchedAt: null });
        } catch (err) {
            this.logger.warn('Failed to mark a client metadata row unusable', { error: err instanceof Error ? err.message : String(err) });
        }
    }
}
