import { createMigration } from '@zyno-io/ts-server-foundation';

export default createMigration(async db => {
    // Table: apps
    await db.rawExecute(`ALTER TABLE "apps" ADD COLUMN "masks" json`);
    await db.rawExecute(`ALTER TABLE "apps" ADD COLUMN "masksVersion" integer NOT NULL DEFAULT 0`);
    await db.rawExecute(`ALTER TABLE "apps" ADD COLUMN "masksUpdatedAt" timestamp`);
    await db.rawExecute(`ALTER TABLE "apps" ADD COLUMN "masksUpdatedById" uuid`);

    // Table: builds_screens
    await db.rawExecute(`ALTER TABLE "builds_screens" ADD COLUMN "appliedMasks" json`);

    // Table: screens
    await db.rawExecute(`ALTER TABLE "screens" ADD COLUMN "masks" json`);
    await db.rawExecute(`ALTER TABLE "screens" ADD COLUMN "masksVersion" integer NOT NULL DEFAULT 0`);
    await db.rawExecute(`ALTER TABLE "screens" ADD COLUMN "masksUpdatedAt" timestamp`);
    await db.rawExecute(`ALTER TABLE "screens" ADD COLUMN "masksUpdatedById" uuid`);
    await db.rawExecute(`ALTER TABLE "screens" ADD COLUMN "inheritAppMasks" boolean NOT NULL DEFAULT TRUE`);
});
