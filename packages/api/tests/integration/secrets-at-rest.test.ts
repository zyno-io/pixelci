import { TestingHelpers } from '@zyno-io/ts-server-foundation';
import { randomBytes } from 'node:crypto';

import { CoreAppOptions } from '../../src/app';
import { UserEntity } from '../../src/entities/User.entity';
import { sealPlaintextSecrets } from '../../src/services/secrets/sealPlaintext';
import { SEALED_PREFIX, SecretBox } from '../../src/services/secrets/SecretBox';
import { configureTestDatabase } from './db-defaults';

process.env.CI = 'true';
process.env.REDIS_PREFIX = 'pixelci_test';

configureTestDatabase();

const VCS_ID = 'e5000000-aaaa-bbbb-cccc-000000000001';
const BAD_VCS_ID = 'e5000000-aaaa-bbbb-cccc-000000000002';
const USER_ID = 'e5000000-aaaa-bbbb-cccc-000000000011';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nCANARY-pem-body\n-----END RSA PRIVATE KEY-----';
const CANARIES = ['CANARY-cs', 'CANARY-pem-body', 'CANARY-at', 'CANARY-rt'];

const K1 = randomBytes(32).toString('hex');
const K2 = randomBytes(32).toString('hex');

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

    console.log('\nTest: plaintext rows are sealed');
    const box = new SecretBox(K1);
    let report = await sealPlaintextSecrets(db, box, { check: true });
    assert(report.integrations.sealed === 1 && report.sessions.sealed === 1, `check should report 2 pending, got ${JSON.stringify(report)}`);
    assert((await text()).cfg.includes('CANARY-cs'), 'check must not write');

    report = await sealPlaintextSecrets(db, box);
    assert(report.integrations.sealed === 1 && report.sessions.sealed === 1, 'first run seals both');
    const t = await text();
    for (const c of CANARIES) assert(!t.cfg.includes(c) && !t.sess.includes(c), `plaintext ${c} left behind`);
    assert(t.cfg.includes(SEALED_PREFIX) && t.sess.includes(SEALED_PREFIX), 'sealed values carry the prefix');
    assert(t.cfg.includes('"clientId"') && t.cfg.includes('"appId"'), 'non-secret fields untouched');
    const cfgRow = (
        await db.rawFind<{ config: { clientSecret: string; privateKey: string } }>(`SELECT config FROM "vcsIntegrations" WHERE id = '${VCS_ID}'`)
    )[0];
    assert(box.open(cfgRow.config.clientSecret) === 'CANARY-cs', 'clientSecret readable');
    assert(box.open(cfgRow.config.privateKey) === PEM, 'privateKey readable');
    console.log('  PASS');

    console.log('\nTest: idempotent; --check clean');
    report = await sealPlaintextSecrets(db, box, { check: true });
    assert(report.integrations.sealed === 0 && report.sessions.sealed === 0, 'nothing pending');
    assert(report.integrations.unreadable.length === 0 && report.sessions.unreadable.length === 0, 'nothing unreadable');
    const before = await text();
    await sealPlaintextSecrets(db, box);
    assert(JSON.stringify(before) === JSON.stringify(await text()), 'second run must not rewrite');
    console.log('  PASS');

    console.log('\nTest: unreadable rows are reported and left untouched');
    const boxOther = new SecretBox(K2);
    const snapshot = await text();
    report = await sealPlaintextSecrets(db, boxOther);
    assert(report.integrations.unreadable.includes(VCS_ID) && report.sessions.unreadable.includes(USER_ID), 'both flagged unreadable');
    assert(JSON.stringify(snapshot) === JSON.stringify(await text()), 'unreadable rows must not change');
    await x(
        `INSERT INTO "vcsIntegrations" (id,name,platform,config) VALUES ('${BAD_VCS_ID}','Bad','gitlab','{"url":"u","clientId":"c","clientSecret":"pcienc:v1:AAAA"}')`
    );
    report = await sealPlaintextSecrets(db, box);
    assert(report.integrations.unreadable.includes(BAD_VCS_ID), 'malformed sealed value flagged');
    console.log('  PASS');
}
