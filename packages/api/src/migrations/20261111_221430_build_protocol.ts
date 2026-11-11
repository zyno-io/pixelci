import { createMigration } from '@zyno-io/ts-server-foundation';

export default createMigration(async db => {
    // Table: builds
    // The default matters during a rolling deploy: this runs before the old pods stop, and builds they create must not look expired to new pods.
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "ciTokensExpireAt" timestamp DEFAULT ((now() AT TIME ZONE 'UTC') + interval '4 hours')`);
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "ciRunId" varchar(64)`);
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "manifestCount" integer`);
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "manifestHash" varchar(64)`);
    // Sessions that exist at deploy time get a grace window so in-flight CI jobs aren't cut off
    await db.rawExecute(
        `UPDATE "builds" SET "ciTokensExpireAt" = (now() AT TIME ZONE 'UTC') + interval '4 hours' WHERE "ciTokenHash" IS NOT NULL OR json_array_length("ciReadTokenHashes") > 0`
    );
});
