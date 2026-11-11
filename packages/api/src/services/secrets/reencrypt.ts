import { BaseDatabase, sql } from '@zyno-io/ts-server-foundation';

import { SecretBox } from './SecretBox';
import { integrationSecretCtx, sessionSecretCtx } from './VcsSecrets';

export interface IReencryptResult {
    scanned: number;
    /** Rows that were rewritten (or, with `check`, that would be). */
    resealed: number;
    /** Ids of rows that could not be read (unknown key id, wrong context or tampered). Left untouched. */
    unreadable: string[];
}

export interface IReencryptReport {
    integrations: IReencryptResult;
    sessions: IReencryptResult;
}

type Json = Record<string, unknown>;

/** Reseals `fields` of `obj` under the active key. Returns undefined when nothing needs to change. */
function resealFields(box: SecretBox, obj: Json, fields: string[], ctx: (f: string) => string): Json | undefined {
    let out: Json | undefined;
    for (const f of fields) {
        const v = obj[f];
        if (typeof v !== 'string' || !box.needsReseal(v)) continue;
        out ??= { ...obj };
        out[f] = box.seal(box.open(v, ctx(f)), ctx(f));
    }
    return out;
}

async function processTable(
    db: BaseDatabase,
    box: SecretBox,
    opts: { check: boolean },
    table: string,
    column: string,
    fieldsFor: (row: { id: string; value: Json }) => string[],
    ctxFor: (id: string) => (f: string) => string
): Promise<IReencryptResult> {
    const result: IReencryptResult = { scanned: 0, resealed: 0, unreadable: [] };
    const ids = (
        await db.rawFind<{ id: string }>(sql`SELECT id FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} IS NOT NULL ORDER BY id`)
    ).map(r => r.id);

    for (const id of ids) {
        // One short transaction per row: the row lock makes the rewrite safe against concurrent saves, and a crash leaves
        // earlier rows done, so the run is resumable and idempotent (resealed values no longer need resealing).
        await db.transaction(async txn => {
            const row = await txn.rawFindOne<{ value: Json | null }>(
                sql`SELECT ${sql.identifier(column)} AS value FROM ${sql.identifier(table)} WHERE id = ${id} FOR UPDATE`
            );
            if (!row?.value) return;
            result.scanned++;
            let next: Json | undefined;
            try {
                next = resealFields(box, row.value, fieldsFor({ id, value: row.value }), ctxFor(id));
            } catch {
                result.unreadable.push(id);
                return;
            }
            if (!next) return;
            result.resealed++;
            if (opts.check) return;
            await txn.rawExecute(sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${JSON.stringify(next)}::json WHERE id = ${id}`);
        });
    }
    return result;
}

/**
 * Seals plaintext secrets and moves values sealed with a non-active key onto the active one. Raw SQL only, so it works from
 * both a migration and a command. With `check`, nothing is written; `resealed` counts what would change.
 */
export async function reencryptAllSecrets(db: BaseDatabase, box: SecretBox, opts: { check?: boolean } = {}): Promise<IReencryptReport> {
    const check = !!opts.check;
    const integrations = await processTable(
        db,
        box,
        { check },
        'vcsIntegrations',
        'config',
        () => ['clientSecret', 'privateKey'],
        id => f => integrationSecretCtx(id, f as 'clientSecret' | 'privateKey')
    );
    const sessions = await processTable(
        db,
        box,
        { check },
        'users',
        'vcsSession',
        () => ['accessToken', 'refreshToken'],
        id => f => sessionSecretCtx(id, f as 'accessToken' | 'refreshToken')
    );
    return { integrations, sessions };
}
