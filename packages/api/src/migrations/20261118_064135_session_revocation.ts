import { createMigration } from '@zyno-io/ts-server-foundation';

export default createMigration(async db => {
    // Table: users
    await db.rawExecute(`ALTER TABLE "users" ADD COLUMN "sessionsValidAfter" timestamp`);
});
