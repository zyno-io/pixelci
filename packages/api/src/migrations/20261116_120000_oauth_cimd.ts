import { createMigration } from '@zyno-io/ts-server-foundation';

export default createMigration(async db => {
    // Client ID Metadata Documents: a cached client is keyed by its client_id URL; DCR rows leave these null.
    await db.rawExecute(`ALTER TABLE "oauth_clients" ADD COLUMN "metadataUrl" varchar(2048)`);
    await db.rawExecute(`ALTER TABLE "oauth_clients" ADD COLUMN "metadataFetchedAt" timestamp`);
    await db.rawExecute(`ALTER TABLE "oauth_clients" ADD COLUMN "metadataExpiresAt" timestamp`);
    await db.rawExecute(`CREATE UNIQUE INDEX "idx_oauth_clients_metadataUrl" ON "oauth_clients" ("metadataUrl")`);
});
