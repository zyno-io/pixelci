import { createMigration, sql } from '@zyno-io/ts-server-foundation';

import { repairLatin1Filename, validateScreenName } from '../services/ScreenUpload';

export default createMigration(async db => {
    // Table: builds
    // No default: during a rolling deploy old pods create builds with a NULL expiry, which the CI auth middleware treats as createdAt/draftActiveAt + TTL.
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "ciTokensExpireAt" timestamp`);
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "ciRunId" varchar(64)`);
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "manifestCount" integer`);
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "manifestHash" varchar(64)`);
    // Sessions that exist at deploy time get a grace window so in-flight CI jobs aren't cut off (UTC: the app writes UTC)
    await db.rawExecute(
        `UPDATE "builds" SET "ciTokensExpireAt" = (now() AT TIME ZONE 'UTC') + interval '4 hours' WHERE "ciTokenHash" IS NOT NULL OR json_array_length("ciReadTokenHashes") > 0`
    );

    // Uploads used to store UTF-8 screen names decoded as latin1 ("café" stored as "cafÃ©"). Uploads now store the real name,
    // so repair existing rows in place to keep each screen's history. A correct non-ASCII name could never have been stored,
    // so the repaired name can't already exist; skip it anyway if it does, or if it isn't a valid name.
    const rows = await db.rawFindUnsafe<{ id: string; appId: string; name: string }>(
        `SELECT id, "appId", name FROM "screens" WHERE name ~ '[^\\x01-\\x7F]'`
    );
    for (const row of rows) {
        const repaired = repairLatin1Filename(row.name);
        if (!repaired || repaired === row.name) continue;
        try {
            validateScreenName(repaired);
        } catch {
            continue;
        }
        await db.rawExecute(
            sql`UPDATE "screens" SET name = ${repaired} WHERE id = ${row.id} AND NOT EXISTS (SELECT 1 FROM "screens" WHERE "appId" = ${row.appId} AND name = ${repaired})`
        );
    }
});
