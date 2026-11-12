import { BaseDatabase, cli, sql } from '@zyno-io/ts-server-foundation';
import { createPrivateKey } from 'node:crypto';

import { Db } from '../database';
import { getSecretBox } from '../services/secrets/SecretBox';

export type IntegrationSecretField = 'clientSecret' | 'privateKey';

/** Encrypts `value` with the current CRYPTO_SECRET and stores it in one config field. Other fields are not read or changed. */
export async function setIntegrationSecret(db: BaseDatabase, id: string, field: IntegrationSecretField, value: string): Promise<void> {
    const row = await db.rawFindOne<{ platform: string }>(sql`SELECT platform FROM "vcsIntegrations" WHERE id = ${id}`);
    if (!row) throw new Error(`Integration ${id} not found`);
    if (field === 'privateKey') {
        if (row.platform !== 'github') throw new Error('privateKey only applies to GitHub integrations');
        // Same normalisation and check as the API: trim the ends only (internal newlines are significant), must parse as a PEM private key.
        value = value.trim();
        try {
            createPrivateKey(value);
        } catch {
            throw new Error('privateKey is not a valid PEM private key');
        }
    }
    const sealed = getSecretBox().seal(value);
    await db.rawExecute(
        sql`UPDATE "vcsIntegrations" SET config = jsonb_set(config::jsonb, ${[field]}::text[], to_jsonb(${sealed}::text))::json WHERE id = ${id}`
    );
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
}

@cli.command('secrets:set-integration', {
    description:
        'Store a replacement secret for an integration (after losing CRYPTO_SECRET). Usage: <integrationId> <clientSecret|privateKey>; value on stdin.'
})
export class SetIntegrationSecretCommand {
    constructor(private db: Db) {}

    async execute(args: unknown[] = []) {
        try {
            await this.run(args.map(String));
        } finally {
            // Release the pool so the process exits now instead of when idle connections time out.
            await this.db.driver.close();
        }
    }

    private async run([id, field]: string[]) {
        if (!id || (field !== 'clientSecret' && field !== 'privateKey') || process.stdin.isTTY) {
            console.error('Usage: printf %s "<value>" | node . secrets:set-integration <integrationId> <clientSecret|privateKey>');
            console.error('       node . secrets:set-integration <integrationId> privateKey < key.pem');
            process.exitCode = 1;
            return;
        }
        const value = (await readStdin()).replace(/\r?\n$/, '');
        if (!value) {
            console.error('Empty value on stdin');
            process.exitCode = 1;
            return;
        }
        try {
            await setIntegrationSecret(this.db, id, field, value);
        } catch (err) {
            console.error((err as Error).message);
            process.exitCode = 1;
            return;
        }
        console.log(`Stored ${field} for integration ${id}`);
    }
}
