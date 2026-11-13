import { createMigration } from '@zyno-io/ts-server-foundation';

export default createMigration(async db => {
    // Table: builds_screens
    await db.rawExecute(`ALTER TABLE "builds_screens" ADD COLUMN "isRemoved" boolean NOT NULL DEFAULT FALSE`);
});
