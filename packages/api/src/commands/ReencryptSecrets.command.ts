import { cli } from '@zyno-io/ts-server-foundation';

import { Db } from '../database';
import { reencryptAllSecrets } from '../services/secrets/reencrypt';
import { getSecretBox } from '../services/secrets/SecretBox';

@cli.command('secrets:reencrypt', {
    description: 'Seal plaintext VCS secrets and move them onto the active key. --check exits 1 if anything needs resealing.'
})
export class ReencryptSecretsCommand {
    constructor(private db: Db) {}

    async execute(args: unknown[] = []) {
        const check = args.includes('--check');
        const box = getSecretBox();
        if (!box.enabled) {
            console.error('SECRETS_ENCRYPTION_KEYS is not set; nothing to do');
            process.exitCode = 1;
            return;
        }

        const report = await reencryptAllSecrets(this.db, box, { check });
        for (const [name, r] of Object.entries(report)) {
            console.log(`${name}: scanned=${r.scanned} ${check ? 'needResealing' : 'resealed'}=${r.resealed} unreadable=${r.unreadable.length}`);
            for (const id of r.unreadable) console.log(`  unreadable: ${id}`);
        }
        const pending = report.integrations.resealed + report.sessions.resealed;
        const unreadable = report.integrations.unreadable.length + report.sessions.unreadable.length;
        if (unreadable || (check && pending)) process.exitCode = 1;
    }
}
