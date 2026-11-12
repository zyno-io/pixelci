import { BaseDatabase, createMigration, getAppConfig, sql } from '@zyno-io/ts-server-foundation';

import { assertSecretsConfig, getSecretBox } from '../services/secrets/SecretBox';

type Json = Record<string, unknown>;

/** True when `value` already decrypts under the current key. AES-GCM authentication makes a false positive on plaintext negligible. */
function isSealed(value: string): boolean {
    try {
        getSecretBox().open(value);
        return true;
    } catch {
        return false;
    }
}

/**
 * Encrypts every plaintext string `field` of the json `column` in each row of `table`. One short transaction per row, under a
 * row lock. Values that already decrypt are skipped, so a rerun (interrupted hook, concurrent migrate, writes by new code before
 * the migration) never double-encrypts.
 */
async function encryptColumn(db: BaseDatabase, table: string, column: string, fields: string[]): Promise<number> {
    const box = getSecretBox();
    const ids = (
        await db.rawFind<{ id: string }>(sql`SELECT id FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} IS NOT NULL ORDER BY id`)
    ).map(r => r.id);

    let count = 0;
    for (const id of ids) {
        await db.transaction(async txn => {
            const row = await txn.rawFindOne<{ value: Json | null }>(
                sql`SELECT ${sql.identifier(column)} AS value FROM ${sql.identifier(table)} WHERE id = ${id} FOR UPDATE`
            );
            if (!row?.value) return;
            const next: Json = { ...row.value };
            let changed = false;
            for (const f of fields) {
                if (typeof next[f] !== 'string' || isSealed(next[f] as string)) continue;
                next[f] = box.seal(next[f] as string);
                changed = true;
            }
            if (!changed) return;
            count++;
            await txn.rawExecute(sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${JSON.stringify(next)}::json WHERE id = ${id}`);
        });
    }
    return count;
}

/** Encrypts all existing plaintext secrets. Safe to run more than once. */
export async function encryptSecrets(db: BaseDatabase) {
    const integrations = await encryptColumn(db, 'vcsIntegrations', 'config', ['clientSecret', 'privateKey']);
    const sessions = await encryptColumn(db, 'users', 'vcsSession', ['accessToken', 'refreshToken']);
    return { integrations, sessions };
}

export default createMigration(async db => {
    assertSecretsConfig(getAppConfig<import('../config').AppConfig>());
    const r = await encryptSecrets(db);
    console.log(`encrypt_secrets: integrations=${r.integrations}, sessions=${r.sessions}`);
});
