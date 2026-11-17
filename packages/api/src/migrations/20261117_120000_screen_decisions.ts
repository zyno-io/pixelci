import { BaseDatabase, createMigration } from '@zyno-io/ts-server-foundation';

/**
 * Pre-0.8 builds were compared with the latest approved default-branch build before them; record that as their reference so
 * the review page keeps showing what it showed. Idempotent (only touches builds with no referenceSource).
 */
export async function backfillLegacyReferences(db: BaseDatabase): Promise<void> {
    await db.rawExecute(`
        UPDATE "builds" b SET "referenceSource" = 'legacy', "referenceBuildId" = (
            SELECT r.id FROM "builds" r JOIN "apps" a ON a.id = b."appId"
            WHERE r."appId" = b."appId" AND r."branchId" = a."defaultBranchId" AND r.status = 'changes approved' AND r.id < b.id
            ORDER BY r.id DESC LIMIT 1
        )
        WHERE b."referenceSource" IS NULL AND b.status IN ('no changes', 'needs review', 'changes approved', 'changes rejected')
    `);
}

export default createMigration(async db => {
    // Table: screen_decisions
    await db.rawExecute(`
        CREATE TABLE "screen_decisions" (
            "id" uuid NOT NULL,
            "appId" uuid NOT NULL,
            "screenId" uuid NOT NULL,
            "kind" varchar(16) NOT NULL,
            "fromImageBuildId" uuid,
            "fromHash" varchar(64),
            "toImageBuildId" uuid,
            "toHash" varchar(64),
            "buildId" uuid NOT NULL,
            "branchId" uuid NOT NULL,
            "buildScreenId" uuid NOT NULL,
            "branchScoped" boolean NOT NULL DEFAULT FALSE,
            "decidedById" uuid NOT NULL,
            "decidedAt" timestamp NOT NULL,
            "comment" text,
            "revokedAt" timestamp,
            "revokedById" uuid,
            PRIMARY KEY ("id")
        )
    `);
    await db.rawExecute(`CREATE UNIQUE INDEX "idx_screen_decisions_buildScreenId" ON "screen_decisions" ("buildScreenId")`);
    await db.rawExecute(`CREATE INDEX "idx_screen_decisions_appId_screenId_id" ON "screen_decisions" ("appId", "screenId", "id")`);

    // Table: builds
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "baseCommits" json`);
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "baseSource" varchar(32)`);
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "referenceBuildId" uuid`);
    await db.rawExecute(`ALTER TABLE "builds" ADD COLUMN "referenceSource" varchar(16)`);

    // Table: builds_screens
    await db.rawExecute(`ALTER TABLE "builds_screens" ADD COLUMN "contentHash" varchar(64)`);
    await db.rawExecute(`ALTER TABLE "builds_screens" ADD COLUMN "baseImageBuildId" uuid`);
    await db.rawExecute(`ALTER TABLE "builds_screens" ADD COLUMN "decisionId" uuid`);
    await db.rawExecute(`ALTER TABLE "builds_screens" ADD COLUMN "reviewCarriedFromId" uuid`);

    await backfillLegacyReferences(db);
});
