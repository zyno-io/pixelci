import { TestingHelpers } from '@zyno-io/ts-server-foundation';
import assert from 'assert';

import { CoreAppOptions } from '../../src/app';
import { UserEntity } from '../../src/entities/User.entity';
import uniqueConstraintsMigration from '../../src/migrations/20261111_120000_unique_constraints';
import { configureTestDatabase } from './db-defaults';

process.env.CI = 'true';
process.env.REDIS_PREFIX = 'pixelci_test';

configureTestDatabase();

const id = (n: number) => `c3234567-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const VCS = id(1);
const APP = id(2);
const BR_OLD = id(10);
const BR_DEFAULT = id(11);
const BR_FEAT_1 = id(12);
const BR_FEAT_2 = id(13);
const U_USER = id(20);
const U_ADMIN = id(21);
// The approved build has the LOWER id, so the status key (not id order) decides which build keeps its commitHash
const B_APPROVED = id(30);
const B_REVIEW = id(31);
const B_FEAT_LOW = id(32);
const B_FEAT_HIGH = id(33);
const S_OLD = id(40);
const S_KEEP = id(41);
// The reviewed row has the LOWER id, so the reviewStatus key decides, not id order
const BS_DUP_REVIEWED = id(50);
const BS_DUP_PLAIN = id(51);
const BS_OLD_SCREEN = id(52);

const INDEXES = [
    'idx_users_vcsId_vcsUserId',
    'idx_branches_appId_name',
    'idx_builds_branchId_commitHash',
    'idx_screens_appId_name',
    'idx_builds_screens_buildId_screenId'
];

run()
    .then(() => {
        console.log('\nAll unique-constraint tests passed!');
        process.exit(0);
    })
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

async function run() {
    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, {
        enableDatabase: true,
        databasePrefix: 'pixelci_uniqtest',
        // The migration runs its own transaction with a table lock; savepoint mode would nest it
        useSavepoints: false
    });
    await facade.start();
    const db = UserEntity.getDatabase();
    const x = (s: string) => db.rawExecute(s);
    const rows = <T = Record<string, unknown>>(s: string) => db.rawFind<T>(s);

    console.log('\nSeeding duplicates on a schema without the unique indexes');
    for (const idx of INDEXES) await x(`DROP INDEX IF EXISTS "${idx}"`);
    // Leave no rows from the facade's own setup in the way
    for (const t of ['builds_screens', 'builds', 'screens', 'branches', 'apps', 'users']) await x(`DELETE FROM ${t}`);

    await x(`INSERT INTO users (id,"vcsId","vcsUserId",name,"isAdmin","lastLoginAt") VALUES
        ('${U_USER}','${VCS}','77','Newer non-admin',false,'2026-02-01'),
        ('${U_ADMIN}','${VCS}','77','Older admin',true,'2026-01-01')`);
    await x(`INSERT INTO apps (id,"vcsId","projectPath",name,"defaultBranchId") VALUES ('${APP}','${VCS}','g/p','App','${BR_DEFAULT}')`);
    await x(`INSERT INTO branches (id,"appId",name) VALUES ('${BR_OLD}','${APP}','main'),('${BR_DEFAULT}','${APP}','main'),
        ('${BR_FEAT_1}','${APP}','feature'),('${BR_FEAT_2}','${APP}','feature')`);
    await x(`INSERT INTO builds (id,"appId","branchId","createdAt","commitHash","commitSubject","commitAuthor","ciJobId","ciReadTokenHashes",status,"approvedById") VALUES
        ('${B_REVIEW}','${APP}','${BR_OLD}',now(),'abc','s','a','1','[]','needs review','${U_USER}'),
        ('${B_APPROVED}','${APP}','${BR_DEFAULT}',now(),'abc','s','a','2','[]','changes approved',NULL),
        ('${B_FEAT_LOW}','${APP}','${BR_FEAT_1}',now(),'def','s','a','3','[]','needs review',NULL),
        ('${B_FEAT_HIGH}','${APP}','${BR_FEAT_2}',now(),'def','s','a','4','[]','needs review',NULL)`);
    await x(`INSERT INTO screens (id,"appId",name) VALUES ('${S_OLD}','${APP}','home'),('${S_KEEP}','${APP}','home')`);
    await x(`INSERT INTO builds_screens (id,"appId","buildId","screenId",status,"reviewStatus","reviewedById") VALUES
        ('${BS_DUP_REVIEWED}','${APP}','${B_APPROVED}','${S_KEEP}','no changes','approved','${U_USER}'),
        ('${BS_DUP_PLAIN}','${APP}','${B_APPROVED}','${S_KEEP}','no changes',NULL,NULL),
        ('${BS_OLD_SCREEN}','${APP}','${B_REVIEW}','${S_OLD}','changes approved',NULL,NULL)`);

    console.log('Running migration');
    await uniqueConstraintsMigration(db);

    console.log('Asserting merges');
    const users = await rows<{ id: string }>(`SELECT id FROM users`);
    assert.deepStrictEqual(
        users.map(u => u.id),
        [U_ADMIN],
        'admin user kept, duplicate removed'
    );
    const [build] = await rows<{ approvedById: string }>(`SELECT "approvedById" FROM builds WHERE id='${B_REVIEW}'`);
    assert.strictEqual(build.approvedById, U_ADMIN, 'build approvedById repointed to keeper');
    const [bs] = await rows<{ reviewedById: string }>(`SELECT "reviewedById" FROM builds_screens WHERE id='${BS_DUP_REVIEWED}'`);
    assert.strictEqual(bs.reviewedById, U_ADMIN, 'reviewedById repointed to keeper');

    const branches = await rows<{ id: string }>(`SELECT id FROM branches`);
    assert.deepStrictEqual(branches.map(b => b.id).sort(), [BR_DEFAULT, BR_FEAT_1], 'default branch kept; non-default duplicates keep the lowest id');
    const builds = await rows<{ id: string; branchId: string; commitHash: string }>(`SELECT id,"branchId","commitHash" FROM builds ORDER BY id`);
    assert(
        [B_APPROVED, B_REVIEW].every(i => builds.find(b => b.id === i)!.branchId === BR_DEFAULT),
        'builds moved to keeper branch'
    );
    assert.strictEqual(builds.find(b => b.id === B_APPROVED)!.commitHash, 'abc', 'approved build keeps its commitHash');
    assert.strictEqual(builds.find(b => b.id === B_REVIEW)!.commitHash, `abc~dup-${B_REVIEW}`, 'other build is renamed');
    assert.strictEqual(builds.find(b => b.id === B_FEAT_HIGH)!.branchId, BR_FEAT_1, 'feature build moved to keeper branch');
    assert.strictEqual(builds.find(b => b.id === B_FEAT_HIGH)!.commitHash, 'def', 'newer build kept on a tie');
    assert.strictEqual(builds.find(b => b.id === B_FEAT_LOW)!.commitHash, `def~dup-${B_FEAT_LOW}`, 'older build renamed on a tie');
    const [app] = await rows<{ defaultBranchId: string }>(`SELECT "defaultBranchId" FROM apps`);
    assert.strictEqual(app.defaultBranchId, BR_DEFAULT, 'app default branch intact');

    const screens = await rows<{ id: string; name: string }>(`SELECT id,name FROM screens`);
    assert.strictEqual(screens.find(s => s.id === S_KEEP)!.name, 'home', 'screen used by the reference build keeps its name despite older rows');
    assert.strictEqual(screens.find(s => s.id === S_OLD)!.name, `home [duplicate ${S_OLD}]`, 'other screen is renamed');

    const bsIds = (await rows<{ id: string }>(`SELECT id FROM builds_screens ORDER BY id`)).map(r => r.id);
    assert.deepStrictEqual(bsIds, [BS_DUP_REVIEWED, BS_OLD_SCREEN].sort(), 'reviewed duplicate builds_screens row kept');

    console.log('Asserting unique indexes exist and are enforced');
    const idx = await rows<{ indexname: string; indisunique: boolean }>(
        `SELECT c.relname indexname, i.indisunique FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
         WHERE c.relname IN (${INDEXES.map(n => `'${n}'`).join(',')})`
    );
    assert.strictEqual(idx.length, INDEXES.length, 'all five indexes exist');
    assert(
        idx.every(i => i.indisunique),
        'all five indexes are unique'
    );
    await assert.rejects(
        x(`INSERT INTO branches (id,"appId",name) VALUES ('${id(99)}','${APP}','main')`),
        /unique|duplicate/i,
        'duplicate branch rejected'
    );
    await assert.rejects(
        x(`INSERT INTO users (id,"vcsId","vcsUserId",name,"lastLoginAt") VALUES ('${id(98)}','${VCS}','77','dup',now())`),
        /unique|duplicate/i,
        'duplicate user rejected'
    );

    console.log('Second run is a no-op');
    const snapshot = async () =>
        JSON.stringify(
            await rows(
                `SELECT 'u' t,id::text,"vcsUserId" v FROM users UNION ALL SELECT 'br',id::text,"appId"::text||name FROM branches
                 UNION ALL SELECT 'b',id::text,"branchId"::text||"commitHash"||COALESCE("approvedById"::text,'') FROM builds
                 UNION ALL SELECT 's',id::text,name FROM screens
                 UNION ALL SELECT 'bs',id::text,"buildId"::text||"screenId"::text||COALESCE("reviewStatus"::text,'') FROM builds_screens ORDER BY 1,2`
            )
        );
    JSON.stringify(await rows(`SELECT 'b' t,id::text,"commitHash" v FROM builds UNION ALL SELECT 's',id::text,name FROM screens ORDER BY 1,2`));
    const before = await snapshot();
    await uniqueConstraintsMigration(db);
    assert.strictEqual(await snapshot(), before, 'second run changes nothing');

    await facade.stop?.();
}
