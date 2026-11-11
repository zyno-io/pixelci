import { createMigration, getAppConfig } from '@zyno-io/ts-server-foundation';

import { reencryptAllSecrets } from '../services/secrets/reencrypt';
import { assertSecretsConfig, getSecretBox } from '../services/secrets/SecretBox';

export default createMigration(async db => {
    const config = getAppConfig<import('../config').AppConfig>();
    assertSecretsConfig(config); // fails in production without keys; warns once elsewhere
    const box = getSecretBox();
    if (!box.enabled) return;

    const report = await reencryptAllSecrets(db, box);
    console.log(
        `encrypt_secrets: integrations resealed=${report.integrations.resealed}, sessions resealed=${report.sessions.resealed}, unreadable=${
            report.integrations.unreadable.length + report.sessions.unreadable.length
        }`
    );
});
