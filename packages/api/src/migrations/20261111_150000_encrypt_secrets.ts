import { createMigration, getAppConfig } from '@zyno-io/ts-server-foundation';

import { sealPlaintextSecrets } from '../services/secrets/sealPlaintext';
import { assertSecretsConfig, getSecretBox } from '../services/secrets/SecretBox';

export default createMigration(async db => {
    const config = getAppConfig<import('../config').AppConfig>();
    assertSecretsConfig(config); // fails in production without CRYPTO_SECRET; warns once elsewhere
    const box = getSecretBox();
    if (!box.enabled) return;

    const report = await sealPlaintextSecrets(db, box);
    console.log(
        `encrypt_secrets: integrations sealed=${report.integrations.sealed}, sessions sealed=${report.sessions.sealed}, unreadable=${
            report.integrations.unreadable.length + report.sessions.unreadable.length
        }`
    );
});
