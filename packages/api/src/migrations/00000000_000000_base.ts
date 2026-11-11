import { createMigration } from '@zyno-io/ts-server-foundation';

export default createMigration(async db => {
    // Table: apps
    await db.rawExecute(`
        CREATE TABLE "apps" (
            "id" uuid NOT NULL,
            "vcsId" uuid NOT NULL,
            "projectPath" varchar(255) NOT NULL,
            "vcsProjectId" bigint,
            "defaultBranchId" uuid NOT NULL,
            "name" varchar(255) NOT NULL,
            "deletedAt" timestamp,
            PRIMARY KEY ("id")
        )
    `);

    // Table: branches
    await db.rawExecute(`
        CREATE TABLE "branches" (
            "id" uuid NOT NULL,
            "appId" uuid NOT NULL,
            "name" varchar(255) NOT NULL,
            PRIMARY KEY ("id")
        )
    `);
    await db.rawExecute(`CREATE INDEX "idx_branches_appId_name" ON "branches" ("appId", "name")`);

    // Table: builds
    await db.rawExecute(
        `CREATE TYPE "builds_status_enum" AS ENUM ('draft', 'processing', 'no changes', 'needs review', 'changes approved', 'changes rejected', 'canceled', 'failed')`
    );
    await db.rawExecute(`
        CREATE TABLE "builds" (
            "id" uuid NOT NULL,
            "appId" uuid NOT NULL,
            "branchId" uuid NOT NULL,
            "createdAt" timestamp NOT NULL,
            "commitHash" varchar(255) NOT NULL,
            "commitSubject" text NOT NULL,
            "commitAuthor" varchar(255) NOT NULL,
            "ciJobId" varchar(255) NOT NULL,
            "ciTokenHash" varchar(255),
            "ciReadTokenHashes" json NOT NULL,
            "draftActiveAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "status" "builds_status_enum" NOT NULL,
            "approvedById" uuid,
            "approvedAt" timestamp,
            PRIMARY KEY ("id")
        )
    `);
    await db.rawExecute(`CREATE INDEX "idx_builds_branchId_commitHash" ON "builds" ("branchId", "commitHash")`);
    await db.rawExecute(`CREATE INDEX "idx_builds_branchId_id" ON "builds" ("branchId", "id")`);
    await db.rawExecute(`CREATE INDEX "idx_builds_appId_createdAt" ON "builds" ("appId", "createdAt")`);

    // Table: builds_screens
    await db.rawExecute(`CREATE TYPE "builds_screens_status_enum" AS ENUM ('new', 'no changes', 'needs review', 'changes approved')`);
    await db.rawExecute(`CREATE TYPE "builds_screens_storageStatus_enum" AS ENUM ('stored', 'pendingDeletion')`);
    await db.rawExecute(`CREATE TYPE "builds_screens_reviewStatus_enum" AS ENUM ('approved', 'rejected')`);
    await db.rawExecute(`
        CREATE TABLE "builds_screens" (
            "id" uuid NOT NULL,
            "appId" uuid NOT NULL,
            "buildId" uuid NOT NULL,
            "screenId" uuid NOT NULL,
            "matchedBuildId" uuid,
            "approvalBuildId" uuid,
            "status" "builds_screens_status_enum",
            "storageStatus" "builds_screens_storageStatus_enum",
            "reviewStatus" "builds_screens_reviewStatus_enum",
            "reviewComment" text,
            "reviewedById" uuid,
            "reviewedAt" timestamp,
            PRIMARY KEY ("id")
        )
    `);
    await db.rawExecute(`CREATE INDEX "idx_builds_screens_screenId_id" ON "builds_screens" ("screenId", "id")`);
    await db.rawExecute(`CREATE INDEX "idx_builds_screens_buildId_screenId" ON "builds_screens" ("buildId", "screenId")`);

    // Table: screens
    await db.rawExecute(`
        CREATE TABLE "screens" (
            "id" uuid NOT NULL,
            "appId" uuid NOT NULL,
            "name" varchar(255) NOT NULL,
            PRIMARY KEY ("id")
        )
    `);
    await db.rawExecute(`CREATE INDEX "idx_screens_appId_name" ON "screens" ("appId", "name")`);

    // Table: users
    await db.rawExecute(`
        CREATE TABLE "users" (
            "id" uuid NOT NULL,
            "vcsId" uuid NOT NULL,
            "vcsUserId" varchar(255) NOT NULL,
            "name" varchar(255) NOT NULL,
            "isAdmin" boolean NOT NULL DEFAULT FALSE,
            "createdAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "lastLoginAt" timestamp NOT NULL,
            "vcsSession" json,
            PRIMARY KEY ("id")
        )
    `);
    await db.rawExecute(`CREATE INDEX "idx_users_vcsId_vcsUserId" ON "users" ("vcsId", "vcsUserId")`);

    // Table: vcsIntegrations
    await db.rawExecute(`CREATE TYPE "vcsIntegrations_platform_enum" AS ENUM ('gitlab', 'github')`);
    await db.rawExecute(`
        CREATE TABLE "vcsIntegrations" (
            "id" uuid NOT NULL,
            "name" varchar(255) NOT NULL,
            "platform" "vcsIntegrations_platform_enum" NOT NULL,
            "config" json NOT NULL,
            PRIMARY KEY ("id")
        )
    `);
});
