import { createRedis, ScopedLogger } from '@zyno-io/ts-server-foundation';

export interface IRateLimitResult {
    allowed: boolean;
    /** Seconds until the window resets (only meaningful when not allowed). */
    retryAfterSeconds: number;
}

/** Longest a rate-limit check may delay a request before it is given up on (fail open). */
const REDIS_TIMEOUT_MS = 1_000;

/**
 * Fixed-window rate limiter on Redis. Fails OPEN (allows, with a warning) when Redis is unreachable: a limiter outage must not take
 * the endpoints it protects down with it.
 */
export class RateLimiterService {
    private redis?: ReturnType<typeof createRedis>;

    constructor(private logger: ScopedLogger) {}

    /** Reports whether one more hit against `key` would be within `limit`, without counting it. Fails open like hit(). */
    async peek(key: string, limit: number): Promise<IRateLimitResult> {
        try {
            this.redis ??= createRedis();
            const { client, prefix } = this.redis;
            const redisKey = `${prefix}:ratelimit:${key}`;
            const work = Promise.all([client.get(redisKey), client.ttl(redisKey)]);
            work.catch(() => undefined);
            const timeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('rate limiter timed out')), REDIS_TIMEOUT_MS).unref()
            );
            const [count, ttl] = await Promise.race([work, timeout]);
            return { allowed: Number(count ?? 0) < limit, retryAfterSeconds: Math.max(1, ttl) };
        } catch (err) {
            this.logger.warn('Rate limiter unavailable; allowing request', { error: err instanceof Error ? err.message : String(err) });
            return { allowed: true, retryAfterSeconds: 0 };
        }
    }

    /** Counts one hit against `key` and reports whether it is within `limit` per `windowSeconds`. */
    async hit(key: string, limit: number, windowSeconds: number): Promise<IRateLimitResult> {
        try {
            this.redis ??= createRedis();
            const { client, prefix } = this.redis;
            const redisKey = `${prefix}:ratelimit:${key}`;

            const work = (async () => {
                const count = await client.incr(redisKey);
                let ttl = windowSeconds;
                if (count === 1) {
                    await client.expire(redisKey, windowSeconds);
                } else {
                    ttl = await client.ttl(redisKey);
                    if (ttl < 0) {
                        // A key without an expiry (the process died between INCR and EXPIRE) would limit forever: repair it.
                        await client.expire(redisKey, windowSeconds);
                        ttl = windowSeconds;
                    }
                }
                return { count, ttl };
            })();
            work.catch(() => undefined);
            const timeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('rate limiter timed out')), REDIS_TIMEOUT_MS).unref()
            );

            const { count, ttl } = await Promise.race([work, timeout]);
            return { allowed: count <= limit, retryAfterSeconds: Math.max(1, ttl) };
        } catch (err) {
            this.logger.warn('Rate limiter unavailable; allowing request', { error: err instanceof Error ? err.message : String(err) });
            return { allowed: true, retryAfterSeconds: 0 };
        }
    }
}
