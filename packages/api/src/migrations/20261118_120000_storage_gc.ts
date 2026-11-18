import { createMigration } from '@zyno-io/ts-server-foundation';

export default createMigration(async db => {
    // Table: storage_sweeps
    await db.rawExecute(`
        CREATE TABLE "storage_sweeps" (
            "appId" uuid NOT NULL,
            "sweptAt" timestamp,
            "cursor" text,
            "updatedAt" timestamp NOT NULL,
            PRIMARY KEY ("appId")
        )
    `);

    // Table: builds_screens
    await db.rawExecute(`CREATE INDEX "idx_builds_screens_baseImageBuildId_screenId" ON "builds_screens" ("baseImageBuildId", "screenId")`);
    await db.rawExecute(`CREATE INDEX "idx_builds_screens_matchedBuildId_screenId" ON "builds_screens" ("matchedBuildId", "screenId")`);

    // Table: screen_decisions
    await db.rawExecute(`CREATE INDEX "idx_screen_decisions_toImageBuildId_screenId" ON "screen_decisions" ("toImageBuildId", "screenId")`);
    await db.rawExecute(`CREATE INDEX "idx_screen_decisions_fromImageBuildId_screenId" ON "screen_decisions" ("fromImageBuildId", "screenId")`);
});
