import { BaseDatabase, sql } from '@zyno-io/ts-server-foundation';

import { SecretBox, SecretUnreadableError } from './SecretBox';

export interface ISealResult {
    scanned: number;
    /** Rows that were rewritten (or, with `check`, that would be). */
    sealed: number;
    /** Ids of rows holding an encrypted value that cannot be read (wrong CRYPTO_SECRET or tampered). Left untouched. */
    unreadable: string[];
}

export interface ISealReport {
    integrations: ISealResult;
    sessions: ISealResult;
}

type Json = Record<string, unknown>;

/**
 * Seals plaintext `fields` of `obj`. Returns undefined when nothing needs to change. Throws SecretUnreadableError when a
 * field is already encrypted but cannot be opened with the configured secret.
 */
function sealFields(box: SecretBox, obj: Json, fields: string[]): Json | undefined {
    let out: Json | undefined;
    for (const f of fields) {
        const v = obj[f];
        if (typeof v !== 'string') continue;
        if (box.needsSeal(v)) {
            out ??= { ...obj };
            out[f] = box.seal(v);
        } else if (v !== '') {
            box.open(v); // encrypted value: verify it is readable (plaintext passes through)
        }
    }
    return out;
}

async function processTable(
    db: BaseDatabase,
    box: SecretBox,
    opts: { check: boolean },
    table: string,
    column: string,
    fields: string[]
): Promise<ISealResult> {
    const result: ISealResult = { scanned: 0, sealed: 0, unreadable: [] };
    const ids = (
        await db.rawFind<{ id: string }>(sql`SELECT id FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} IS NOT NULL ORDER BY id`)
    ).map(r => r.id);

    for (const id of ids) {
        // One short transaction per row: the row lock makes the rewrite safe against concurrent saves, and a crash leaves
        // earlier rows done, so the run is resumable and idempotent (sealed values no longer need sealing).
        await db.transaction(async txn => {
            const row = await txn.rawFindOne<{ value: Json | null }>(
                sql`SELECT ${sql.identifier(column)} AS value FROM ${sql.identifier(table)} WHERE id = ${id} FOR UPDATE`
            );
            if (!row?.value) return;
            result.scanned++;
            let next: Json | undefined;
            try {
                next = sealFields(box, row.value, fields);
            } catch (err) {
                if (!(err instanceof SecretUnreadableError)) throw err;
                result.unreadable.push(id);
                return;
            }
            if (!next) return;
            result.sealed++;
            if (opts.check) return;
            await txn.rawExecute(sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${JSON.stringify(next)}::json WHERE id = ${id}`);
        });
    }
    return result;
}

/**
 * Seals plaintext secrets. Already-encrypted values are never touched; one that cannot be opened is reported as unreadable.
 * Raw SQL only, so it works from both a migration and a command. With `check`, nothing is written; `sealed` counts what would change.
 */
export async function sealPlaintextSecrets(db: BaseDatabase, box: SecretBox, opts: { check?: boolean } = {}): Promise<ISealReport> {
    const check = !!opts.check;
    const integrations = await processTable(db, box, { check }, 'vcsIntegrations', 'config', ['clientSecret', 'privateKey']);
    const sessions = await processTable(db, box, { check }, 'users', 'vcsSession', ['accessToken', 'refreshToken']);
    return { integrations, sessions };
}
