import { createMigration } from '@zyno-io/ts-server-foundation';

const RETRYABLE_SQLSTATES = ['40P01', '55P03']; // deadlock_detected, lock_not_available (lock_timeout)
const MAX_ATTEMPTS = 10;

const sqlState = (e: unknown): unknown => {
    const c = e as { code?: unknown; cause?: { code?: unknown } } | null;
    return c?.code ?? c?.cause?.code;
};

export default createMigration(async db => {
    for (let attempt = 1; ; attempt++) {
        try {
            await migrate(db);
            return;
        } catch (e) {
            if (attempt >= MAX_ATTEMPTS || !RETRYABLE_SQLSTATES.includes(String(sqlState(e)))) throw e;
            const delayMs = Math.min(500 * 2 ** (attempt - 1), 8000);
            console.warn(`unique_constraints migration attempt ${attempt} failed (${sqlState(e)}); retrying in ${delayMs}ms`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
});

type Db = Parameters<Parameters<typeof createMigration>[0]>[0];

async function migrate(db: Db) {
    await db.transaction(async txn => {
        const run = (s: string) => txn.rawExecute(s);
        // Below deadlock_timeout (1s), so the migration always gives up first instead of a live transaction being picked as the victim.
        await run(`SET LOCAL lock_timeout = '500ms'`);
        // Old pods serve during the pre-upgrade hook. Take the strongest lock up front (it also blocks readers, briefly):
        // a weaker lock would later be upgraded by DROP INDEX, which deadlocks with old pods' SELECT ... FOR UPDATE transactions.
        // If the lock can't be had in time, the whole transaction is retried.
        // Order matters: old pods' uploadScreen touches screens -> builds_screens -> builds, so lock in that order (builds last).
        await run(`LOCK TABLE users, apps, branches, screens, builds_screens, builds IN ACCESS EXCLUSIVE MODE`);

        await run(`WITH k AS (SELECT "vcsId","vcsUserId",(array_agg(id ORDER BY "isAdmin" DESC,"lastLoginAt" DESC,id))[1] keeper
                                 FROM users GROUP BY 1,2 HAVING count(*)>1),
                           m AS (SELECT u.id dup,k.keeper FROM users u JOIN k USING ("vcsId","vcsUserId") WHERE u.id<>k.keeper),
                           b AS (UPDATE builds SET "approvedById"=m.keeper FROM m WHERE builds."approvedById"=m.dup RETURNING 1),
                           s AS (UPDATE builds_screens SET "reviewedById"=m.keeper FROM m WHERE builds_screens."reviewedById"=m.dup RETURNING 1)
                       DELETE FROM users USING m WHERE users.id=m.dup`);

        await run(`WITH k AS (SELECT br."appId",br.name,(array_agg(br.id ORDER BY COALESCE(br.id=a."defaultBranchId",false) DESC,br.id))[1] keeper
                                 FROM branches br LEFT JOIN apps a ON a.id=br."appId" GROUP BY br."appId",br.name HAVING count(*)>1),
                           m AS (SELECT br.id dup,k.keeper FROM branches br JOIN k ON k."appId"=br."appId" AND k.name=br.name WHERE br.id<>k.keeper),
                           b AS (UPDATE builds SET "branchId"=m.keeper FROM m WHERE builds."branchId"=m.dup RETURNING 1),
                           a AS (UPDATE apps SET "defaultBranchId"=m.keeper FROM m WHERE apps."defaultBranchId"=m.dup RETURNING 1)
                       DELETE FROM branches USING m WHERE branches.id=m.dup`);

        // builds: keep the most useful row; rename the others' commitHash (images and matchedBuildId refs stay valid)
        await run(`UPDATE builds SET "commitHash"=left(builds."commitHash",200)||'~dup-'||builds.id::text
                       FROM (SELECT id,row_number() OVER (PARTITION BY "branchId","commitHash" ORDER BY
                               CASE status WHEN 'changes approved' THEN 0 WHEN 'no changes' THEN 1 WHEN 'needs review' THEN 2
                                           WHEN 'changes rejected' THEN 3 WHEN 'processing' THEN 4 ELSE 5 END, id DESC) rn FROM builds) r
                       WHERE builds.id=r.id AND r.rn>1`);

        // screens: keep the slot the reference build uses, then the most recently used one; rename the rest
        // (S3 keys embed screenId, so no merge). The reference build is the latest approved build on the default branch.
        await run(`UPDATE screens SET name=left(screens.name,200)||' [duplicate '||screens.id::text||']'
                       FROM (SELECT s.id,row_number() OVER (PARTITION BY s."appId",s.name ORDER BY
                               (EXISTS (SELECT 1 FROM builds_screens bs WHERE bs."screenId"=s.id AND bs."buildId"=
                                  (SELECT rb.id FROM builds rb JOIN apps a ON a.id=s."appId" AND rb."branchId"=a."defaultBranchId"
                                    WHERE rb.status='changes approved' ORDER BY rb.id DESC LIMIT 1))) DESC,
                               (SELECT bs.id FROM builds_screens bs WHERE bs."screenId"=s.id ORDER BY bs.id DESC LIMIT 1) DESC NULLS LAST,
                               (SELECT bs.id FROM builds_screens bs WHERE bs."screenId"=s.id AND bs.status='changes approved' ORDER BY bs.id DESC LIMIT 1) DESC NULLS LAST,
                               s.id) rn
                             FROM screens s WHERE (s."appId",s.name) IN (SELECT "appId",name FROM screens GROUP BY 1,2 HAVING count(*)>1)) r
                       WHERE screens.id=r.id AND r.rn>1`);

        await run(`DELETE FROM builds_screens USING (SELECT id,row_number() OVER (PARTITION BY "buildId","screenId"
                         ORDER BY ("reviewStatus" IS NOT NULL) DESC, ("reviewStatus" = 'rejected') DESC, "reviewedAt" ASC NULLS LAST, id DESC) rn FROM builds_screens) r
                       WHERE builds_screens.id=r.id AND r.rn>1`);

        for (const [t, idx, cols] of [
            ['users', 'idx_users_vcsId_vcsUserId', '"vcsId","vcsUserId"'],
            ['branches', 'idx_branches_appId_name', '"appId",name'],
            ['builds', 'idx_builds_branchId_commitHash', '"branchId","commitHash"'],
            ['screens', 'idx_screens_appId_name', '"appId",name'],
            ['builds_screens', 'idx_builds_screens_buildId_screenId', '"buildId","screenId"']
        ]) {
            await run(`DROP INDEX IF EXISTS "${idx}"`);
            await run(`CREATE UNIQUE INDEX "${idx}" ON ${t} (${cols})`);
        }
    });
}
