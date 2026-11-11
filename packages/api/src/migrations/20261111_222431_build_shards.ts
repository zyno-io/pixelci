import { createMigration } from '@zyno-io/ts-server-foundation';

export default createMigration(async db => {
    // Table: builds_shards
    await db.rawExecute(`
        CREATE TABLE "builds_shards" (
            "id" uuid NOT NULL,
            "buildId" uuid NOT NULL,
            "shardIndex" integer NOT NULL,
            "ciTokenHash" varchar(255) NOT NULL,
            "ciJobId" varchar(255) NOT NULL,
            "state" varchar(16) NOT NULL,
            "manifestCount" integer NOT NULL,
            "manifestHash" varchar(64) NOT NULL,
            "runId" varchar(64),
            "activeAt" timestamp NOT NULL,
            PRIMARY KEY ("id"),
            CONSTRAINT "builds_shards_state_check" CHECK ("state" IN ('uploading', 'uploaded'))
        )
    `);
    await db.rawExecute(`CREATE INDEX "idx_builds_shards_buildId_ciTokenHash" ON "builds_shards" ("buildId", "ciTokenHash")`);
    await db.rawExecute(`CREATE UNIQUE INDEX "idx_builds_shards_buildId_shardIndex" ON "builds_shards" ("buildId", "shardIndex")`);

    // Table: builds
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "shardTotal" integer NOT NULL DEFAULT 1`);

    // Table: builds_screens
    await db.rawExecute(`ALTER TABLE "builds_screens" ADD COLUMN "shardIndex" integer NOT NULL DEFAULT 1`);
});
