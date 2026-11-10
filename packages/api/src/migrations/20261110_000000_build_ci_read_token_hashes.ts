import { Db } from '../database';

export default async function (db: Db) {
    await db.rawExecute(`
        ALTER TABLE builds
        ADD COLUMN \`ciReadTokenHashes\` json NOT NULL DEFAULT (JSON_ARRAY()),
        ADD COLUMN \`draftActiveAt\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;
    `);
    await db.rawExecute(`UPDATE builds SET draftActiveAt = createdAt;`);
}
