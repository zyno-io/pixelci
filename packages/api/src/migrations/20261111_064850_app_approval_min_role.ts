import { createMigration } from '@zyno-io/ts-server-foundation';

export default createMigration(async db => {
    // Table: apps. ADD COLUMN ... NOT NULL DEFAULT backfills every existing app to 'write'.
    await db.rawExecute(`ALTER TABLE "apps" ADD COLUMN "approvalMinRole" varchar(16) NOT NULL DEFAULT 'write'`);
    await db.rawExecute(`ALTER TABLE "apps" ADD CONSTRAINT "chk_apps_approvalMinRole" CHECK ("approvalMinRole" IN ('read', 'write', 'maintain'))`);
});
