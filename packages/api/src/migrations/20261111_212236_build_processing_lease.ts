import { createMigration } from '@zyno-io/ts-server-foundation';

export default createMigration(async db => {
    // Table: builds
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "processingAttemptId" uuid`);
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "processingHeartbeatAt" timestamp`);
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "processingStartedAt" timestamp`);
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "processingAttempts" integer NOT NULL DEFAULT 0`);
    await db.rawExecute(`CREATE INDEX "idx_builds_status_processingStartedAt" ON "builds" ("status", "processingStartedAt")`);
    // Builds already stuck in processing get a lease clock, so the reaper fails them (or retries them) on its first run.
    await db.rawExecute(
        `UPDATE "builds" SET "processingStartedAt" = COALESCE("draftActiveAt", "createdAt"), "processingHeartbeatAt" = COALESCE("draftActiveAt", "createdAt") WHERE "status" = 'processing'`
    );
});
