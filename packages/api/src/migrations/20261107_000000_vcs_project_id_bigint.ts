import { Db } from '../database';

export default async function (db: Db) {
    await db.rawExecute(`
        ALTER TABLE apps MODIFY COLUMN vcsProjectId BIGINT NULL;
    `);
}
