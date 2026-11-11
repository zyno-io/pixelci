import { createMigration } from '@zyno-io/ts-server-foundation';

export default createMigration(async db => {
    // Table: apps
    await db.rawExecute(`ALTER TABLE "apps" ADD COLUMN "colorTolerance" double precision`);
    await db.rawExecute(`ALTER TABLE "apps" ADD COLUMN "shiftTolerance" integer`);
    await db.rawExecute(`ALTER TABLE "apps" ADD COLUMN "diffPctTolerance" double precision`);

    // Table: screens
    await db.rawExecute(`ALTER TABLE "screens" ADD COLUMN "colorTolerance" double precision`);
    await db.rawExecute(`ALTER TABLE "screens" ADD COLUMN "shiftTolerance" integer`);
    await db.rawExecute(`ALTER TABLE "screens" ADD COLUMN "diffPctTolerance" double precision`);
});
