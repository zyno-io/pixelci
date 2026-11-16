import { createMigration } from '@zyno-io/ts-server-foundation';

export default createMigration(async db => {
    // Table: oauth_clients
    await db.rawExecute(`
        CREATE TABLE "oauth_clients" (
            "id" uuid NOT NULL,
            "name" varchar(100) NOT NULL,
            "redirectUris" json NOT NULL,
            "tokenEndpointAuthMethod" varchar(32) NOT NULL,
            "secretHash" varchar(64),
            "createdAt" timestamp NOT NULL,
            "lastUsedAt" timestamp,
            PRIMARY KEY ("id"),
            CONSTRAINT "oauth_clients_tokenEndpointAuthMethod_check" CHECK ("tokenEndpointAuthMethod" IN ('none', 'client_secret_post', 'client_secret_basic'))
        )
    `);

    // Table: oauth_authorizations
    await db.rawExecute(`
        CREATE TABLE "oauth_authorizations" (
            "id" uuid NOT NULL,
            "clientId" uuid NOT NULL,
            "userId" uuid,
            "redirectUri" varchar(2048) NOT NULL,
            "state" text,
            "codeChallenge" varchar(43) NOT NULL,
            "scope" varchar(255) NOT NULL,
            "resource" varchar(2048) NOT NULL,
            "status" varchar(16) NOT NULL,
            "codeHash" varchar(64),
            "grantId" uuid,
            "createdAt" timestamp NOT NULL,
            "expiresAt" timestamp NOT NULL,
            "approvedAt" timestamp,
            "redeemedAt" timestamp,
            PRIMARY KEY ("id"),
            CONSTRAINT "oauth_authorizations_status_check" CHECK ("status" IN ('pending', 'approved', 'denied', 'redeemed'))
        )
    `);
    await db.rawExecute(`CREATE UNIQUE INDEX "idx_oauth_authorizations_codeHash" ON "oauth_authorizations" ("codeHash")`);
    await db.rawExecute(`CREATE INDEX "idx_oauth_authorizations_expiresAt" ON "oauth_authorizations" ("expiresAt")`);
    await db.rawExecute(`CREATE INDEX "idx_oauth_authorizations_clientId" ON "oauth_authorizations" ("clientId")`);

    // Table: oauth_grants
    await db.rawExecute(`
        CREATE TABLE "oauth_grants" (
            "id" uuid NOT NULL,
            "clientId" uuid NOT NULL,
            "userId" uuid NOT NULL,
            "scope" varchar(255) NOT NULL,
            "resource" varchar(2048) NOT NULL,
            "redirectUri" varchar(2048) NOT NULL,
            "createdAt" timestamp NOT NULL,
            "expiresAt" timestamp NOT NULL,
            "lastUsedAt" timestamp,
            "revokedAt" timestamp,
            "revokedReason" varchar(32),
            PRIMARY KEY ("id"),
            CONSTRAINT "oauth_grants_revokedReason_check" CHECK ("revokedReason" IN ('user', 'client_revoke', 'refresh_reuse', 'code_reuse', 'vcs_session', 'superseded'))
        )
    `);
    await db.rawExecute(`CREATE INDEX "idx_oauth_grants_userId_revokedAt" ON "oauth_grants" ("userId", "revokedAt")`);
    await db.rawExecute(`CREATE INDEX "idx_oauth_grants_clientId" ON "oauth_grants" ("clientId")`);

    // Table: oauth_tokens
    await db.rawExecute(`
        CREATE TABLE "oauth_tokens" (
            "id" uuid NOT NULL,
            "grantId" uuid NOT NULL,
            "kind" varchar(16) NOT NULL,
            "tokenHash" varchar(64) NOT NULL,
            "createdAt" timestamp NOT NULL,
            "expiresAt" timestamp NOT NULL,
            "rotatedAt" timestamp,
            PRIMARY KEY ("id"),
            CONSTRAINT "oauth_tokens_kind_check" CHECK ("kind" IN ('access', 'refresh'))
        )
    `);
    await db.rawExecute(`CREATE UNIQUE INDEX "idx_oauth_tokens_tokenHash" ON "oauth_tokens" ("tokenHash")`);
    await db.rawExecute(`CREATE INDEX "idx_oauth_tokens_grantId" ON "oauth_tokens" ("grantId")`);
    await db.rawExecute(`CREATE INDEX "idx_oauth_tokens_expiresAt" ON "oauth_tokens" ("expiresAt")`);
});
