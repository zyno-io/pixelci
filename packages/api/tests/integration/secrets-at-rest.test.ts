import { TestingHelpers } from '@zyno-io/ts-server-foundation';
import { randomBytes } from 'node:crypto';

import { CoreAppOptions } from '../../src/app';
import { setIntegrationSecret } from '../../src/commands/SetIntegrationSecret.command';
import { UserEntity } from '../../src/entities/User.entity';
import { encryptSecrets } from '../../src/migrations/20261111_150000_encrypt_secrets';
import { getSecretBox, SecretBox, SecretUnreadableError, setSecretBoxForTesting } from '../../src/services/secrets/SecretBox';
import { configureTestDatabase } from './db-defaults';

process.env.CI = 'true';
process.env.REDIS_PREFIX = 'pixelci_test';

configureTestDatabase();

const VCS_ID = 'e5000000-aaaa-bbbb-cccc-000000000001';
const USER_ID = 'e5000000-aaaa-bbbb-cccc-000000000011';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nCANARY-pem-body\n-----END RSA PRIVATE KEY-----';
const CANARIES = ['CANARY-cs', 'CANARY-pem-body', 'CANARY-at', 'CANARY-rt'];

const OTHER_KEY = randomBytes(32).toString('hex');

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(`FAIL: ${msg}`);
}

run()
    .then(() => {
        console.log('\nAll secrets-at-rest tests passed!');
        process.exit(0);
    })
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

async function run() {
    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, {
        enableDatabase: true,
        databasePrefix: 'pixelci_secretstest'
    });
    await facade.start();
    const db = UserEntity.getDatabase();
    const x = (s: string) => db.rawExecute(s);
    const text = async () => ({
        cfg: (await db.rawFind<{ t: string }>(`SELECT config::text AS t FROM "vcsIntegrations" WHERE id = '${VCS_ID}'`))[0].t,
        sess: (await db.rawFind<{ t: string }>(`SELECT "vcsSession"::text AS t FROM users WHERE id = '${USER_ID}'`))[0].t
    });

    await x(`DELETE FROM users`);
    await x(`DELETE FROM "vcsIntegrations"`);
    await x(`INSERT INTO "vcsIntegrations" (id,name,platform,config) VALUES ('${VCS_ID}','Secrets','github',
        '${JSON.stringify({ clientId: 'cid', clientSecret: 'CANARY-cs', privateKey: PEM, appId: '1', oidcAudience: 'a' }).replace(/'/g, "''")}')`);
    await x(`INSERT INTO users (id,"vcsId","vcsUserId",name,"isAdmin","lastLoginAt","vcsSession") VALUES ('${USER_ID}','${VCS_ID}','1','U',false,now(),
        '${JSON.stringify({ accessToken: 'CANARY-at', refreshToken: 'CANARY-rt', expiresAt: 1, redirectUri: 'r' })}')`);

    // The migration runs against the test app's CRYPTO_SECRET (from .env.development).
    const box = getSecretBox();

    console.log('\nTest: the migration encrypts plaintext rows');
    const result = await encryptSecrets(db);
    assert(result.integrations === 1 && result.sessions === 1, `expected 1 integration and 1 session, got ${JSON.stringify(result)}`);
    const t = await text();
    for (const c of CANARIES) assert(!t.cfg.includes(c) && !t.sess.includes(c), `plaintext ${c} left behind`);
    assert(t.cfg.includes('"clientId"') && t.cfg.includes('"appId"'), 'non-secret fields untouched');
    const cfgRow = (
        await db.rawFind<{ config: { clientSecret: string; privateKey: string } }>(`SELECT config FROM "vcsIntegrations" WHERE id = '${VCS_ID}'`)
    )[0];
    const sessRow = (
        await db.rawFind<{ s: { accessToken: string; refreshToken: string } }>(`SELECT "vcsSession" AS s FROM users WHERE id = '${USER_ID}'`)
    )[0];
    assert(
        cfgRow.config.clientSecret !== 'CANARY-cs' && box.open(cfgRow.config.clientSecret) === 'CANARY-cs',
        'clientSecret decrypts to the original'
    );
    assert(cfgRow.config.privateKey !== PEM && box.open(cfgRow.config.privateKey) === PEM, 'privateKey decrypts to the original');
    assert(box.open(sessRow.s.accessToken) === 'CANARY-at' && box.open(sessRow.s.refreshToken) === 'CANARY-rt', 'session tokens decrypt');
    console.log('  PASS');

    console.log('\nTest: lost key makes values unreadable');
    const other = new SecretBox(OTHER_KEY);
    for (const v of [cfgRow.config.clientSecret, cfgRow.config.privateKey, sessRow.s.accessToken]) {
        let threw = false;
        try {
            other.open(v);
        } catch (e) {
            threw = e instanceof SecretUnreadableError;
        }
        assert(threw, 'a different key must raise SecretUnreadableError');
    }
    console.log('  PASS');

    console.log('\nTest: secrets:set-integration replaces one field and leaves the rest untouched');
    setSecretBoxForTesting(other);
    try {
        await setIntegrationSecret(db, VCS_ID, 'clientSecret', 'CANARY-new-cs');
        await setIntegrationSecret(db, VCS_ID, 'privateKey', PEM.replace('CANARY-pem-body', 'CANARY-new-pem'));
    } finally {
        setSecretBoxForTesting(undefined);
    }
    const after = (await db.rawFind<{ config: Record<string, string> }>(`SELECT config FROM "vcsIntegrations" WHERE id = '${VCS_ID}'`))[0].config;
    assert(other.open(after.clientSecret) === 'CANARY-new-cs', 'clientSecret replaced and sealed with the current key');
    assert(other.open(after.privateKey).includes('CANARY-new-pem') && other.open(after.privateKey).includes('\n'), 'privateKey keeps line breaks');
    assert(after.clientId === 'cid' && after.appId === '1' && after.oidcAudience === 'a', 'other fields untouched');
    assert(JSON.stringify((await text()).sess) === JSON.stringify(t.sess), 'sessions untouched');

    let err = '';
    try {
        await setIntegrationSecret(db, 'e5000000-aaaa-bbbb-cccc-0000000000ff', 'clientSecret', 'x');
    } catch (e) {
        err = (e as Error).message;
    }
    assert(err.includes('not found'), 'unknown integration is rejected');
    await x(
        `INSERT INTO "vcsIntegrations" (id,name,platform,config) VALUES ('e5000000-aaaa-bbbb-cccc-000000000002','GL','gitlab','{"url":"u","clientId":"c","clientSecret":"x"}')`
    );
    err = '';
    try {
        await setIntegrationSecret(db, 'e5000000-aaaa-bbbb-cccc-000000000002', 'privateKey', 'x');
    } catch (e) {
        err = (e as Error).message;
    }
    assert(err.includes('GitHub'), 'privateKey on a non-GitHub integration is rejected');
    console.log('  PASS');
}
