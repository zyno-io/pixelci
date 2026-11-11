import { createMigration } from '@zyno-io/ts-server-foundation';

export default createMigration(async db => {
    // Table: builds
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "ciTokensExpireAt" timestamp`);
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "manifestCount" integer`);
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "manifestHash" varchar(64)`);
    // Sessions that exist at deploy time get a grace window so in-flight CI jobs aren't cut off
    await db.rawExecute(
        `UPDATE "builds" SET "ciTokensExpireAt" = CURRENT_TIMESTAMP + interval '4 hours' WHERE "ciTokenHash" IS NOT NULL OR json_array_length("ciReadTokenHashes") > 0`
    );
});
