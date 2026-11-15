import { BaseJob, ScopedLogger, sql, WorkerJob } from '@zyno-io/ts-server-foundation';

import { Db } from '../database';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Hourly cleanup of OAuth state. Cutoffs are computed here and bound as parameters (the columns hold naive UTC, so `now()` is not
 * used). Rotated refresh tokens are kept until they expire, which preserves refresh-reuse detection; authorizations are kept a day
 * past expiry so a replayed code is still recognised.
 */
@WorkerJob({ cronSchedule: '17 * * * *', queueName: 'maintenance' })
export class PruneOAuthJob extends BaseJob<void> {
    constructor(
        private db: Db,
        private logger: ScopedLogger
    ) {
        super();
    }

    async handle() {
        const now = Date.now();
        const nowDate = new Date(now);
        const dayAgo = new Date(now - DAY_MS);
        const monthAgo = new Date(now - 30 * DAY_MS);
        const weekAgo = new Date(now - 7 * DAY_MS);
        const quarterAgo = new Date(now - 90 * DAY_MS);

        const run = async (label: string, query: ReturnType<typeof sql>) => {
            const res = await this.db.rawExecute(query);
            if (res.affectedRows) this.logger.info(`Pruned OAuth ${label}`, { count: res.affectedRows });
        };

        await run('tokens (expired)', sql`DELETE FROM "oauth_tokens" WHERE "expiresAt" < ${nowDate}`);
        await run(
            'tokens (revoked grants)',
            sql`DELETE FROM "oauth_tokens" WHERE "grantId" IN (SELECT "id" FROM "oauth_grants" WHERE "revokedAt" IS NOT NULL)`
        );
        await run('grants', sql`DELETE FROM "oauth_grants" WHERE ("revokedAt" IS NOT NULL AND "revokedAt" < ${monthAgo}) OR "expiresAt" < ${dayAgo}`);
        await run('authorizations', sql`DELETE FROM "oauth_authorizations" WHERE "expiresAt" < ${dayAgo}`);
        await run(
            'clients',
            sql`DELETE FROM "oauth_clients" c
                WHERE NOT EXISTS (SELECT 1 FROM "oauth_grants" g WHERE g."clientId" = c."id")
                  AND NOT EXISTS (SELECT 1 FROM "oauth_authorizations" a WHERE a."clientId" = c."id" AND a."expiresAt" >= ${nowDate})
                  AND (
                      (c."lastUsedAt" IS NULL AND c."createdAt" < ${weekAgo})
                      OR c."lastUsedAt" < ${quarterAgo}
                  )`
        );
    }
}
