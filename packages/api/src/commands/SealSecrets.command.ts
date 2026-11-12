import { cli } from '@zyno-io/ts-server-foundation';

import { Db } from '../database';
import { sealPlaintextSecrets } from '../services/secrets/sealPlaintext';
import { getSecretBox } from '../services/secrets/SecretBox';

@cli.command('secrets:seal', {
    description: 'Encrypt plaintext VCS secrets. --check exits 1 if anything is still plaintext or unreadable.'
})
export class SealSecretsCommand {
    constructor(private db: Db) {}

    async execute(args: unknown[] = []) {
        const check = args.includes('--check');
        const box = getSecretBox();
        if (!box.enabled) {
            console.error('CRYPTO_SECRET is not set; nothing to do');
            process.exitCode = 1;
            return;
        }

        const report = await sealPlaintextSecrets(this.db, box, { check });
        for (const [name, r] of Object.entries(report)) {
            console.log(`${name}: scanned=${r.scanned} ${check ? 'needSealing' : 'sealed'}=${r.sealed} unreadable=${r.unreadable.length}`);
            for (const id of r.unreadable) console.log(`  unreadable: ${id}`);
        }
        const pending = report.integrations.sealed + report.sessions.sealed;
        const unreadable = report.integrations.unreadable.length + report.sessions.unreadable.length;
        if (unreadable || (check && pending)) process.exitCode = 1;
    }
}
