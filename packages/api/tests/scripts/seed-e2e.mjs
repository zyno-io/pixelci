import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

// Timestamps are `timestamp without time zone` holding UTC wall-clock values; bind JS Dates as UTC, not local time.
pg.defaults.parseInputDatesAsUTC = true;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'integration', 'fixtures');

// Stored VCS secrets are ciphertext (TSF Crypto: AES-256-GCM, base64 of iv(12) | ciphertext | tag(16)), keyed by CRYPTO_SECRET.
function cryptoSecretKey() {
    let secret = process.env.CRYPTO_SECRET;
    if (!secret) {
        const envFile = fs.readFileSync(path.join(__dirname, '..', '..', '.env.development'), 'utf8');
        secret = envFile.match(/^CRYPTO_SECRET=(.+)$/m)?.[1]?.trim();
    }
    if (!secret) throw new Error('CRYPTO_SECRET is not set and not found in .env.development');
    return /^[0-9a-f]{64}$/i.test(secret) ? Buffer.from(secret, 'hex') : Buffer.from(secret);
}

function sealSecret(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', cryptoSecretKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64');
}

// IDs
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const APP_ID = '00000000-0000-0000-0000-000000000001';
const MAIN_BRANCH_ID = '00000000-0000-0000-0000-000000000002';
const FEAT_BRANCH_ID = '00000000-0000-0000-0000-000000000030';

// Build IDs
const BUILD_003_ID = '00000000-0000-0000-0000-000000000003';
const BUILD_004_ID = '00000000-0000-0000-0000-000000000004';
const BUILD_005_ID = '00000000-0000-0000-0000-000000000005';
const BUILD_006_ID = '00000000-0000-0000-0000-000000000006';
const BUILD_007_ID = '00000000-0000-0000-0000-000000000007';

// Screen IDs
const SCREEN_HOMEPAGE_ID = '00000000-0000-0000-0000-000000000010';
const SCREEN_DASHBOARD_ID = '00000000-0000-0000-0000-000000000011';
const SCREEN_SETTINGS_ID = '00000000-0000-0000-0000-000000000012';
const SCREEN_LOGIN_ID = '00000000-0000-0000-0000-000000000013';

// Build-screen IDs
const BS_020 = '00000000-0000-0000-0000-000000000020';
const BS_021 = '00000000-0000-0000-0000-000000000021';
const BS_022 = '00000000-0000-0000-0000-000000000022';
const BS_023 = '00000000-0000-0000-0000-000000000023';
const BS_024 = '00000000-0000-0000-0000-000000000024';
const BS_025 = '00000000-0000-0000-0000-000000000025';
const BS_026 = '00000000-0000-0000-0000-000000000026';
const BS_027 = '00000000-0000-0000-0000-000000000027';
const BS_028 = '00000000-0000-0000-0000-000000000028';
const BS_029 = '00000000-0000-0000-0000-000000000029';
const BS_02A = '00000000-0000-0000-0000-00000000002a';
const BS_02B = '00000000-0000-0000-0000-00000000002b';
const BS_02C = '00000000-0000-0000-0000-00000000002c';
const BS_02D = '00000000-0000-0000-0000-00000000002d';

// Load real fixture images
const FINDER_1 = fs.readFileSync(path.join(fixturesDir, 'finder-1.png'));
const FINDER_1_CHANGED = fs.readFileSync(path.join(fixturesDir, 'finder-1-changed.png'));
const FINDER_2 = fs.readFileSync(path.join(fixturesDir, 'finder-2.png'));
const FINDER_2_CHANGED = fs.readFileSync(path.join(fixturesDir, 'finder-2-changed.png'));
const FINDER_2_CHANGED_2 = fs.readFileSync(path.join(fixturesDir, 'finder-2-changed-2.png'));
const FINDER_1_DIFF = fs.readFileSync(path.join(fixturesDir, 'finder-1-diff.png'));

async function connect() {
    const conn = new pg.Client({
        host: process.env.PG_HOST || '127.0.0.1',
        port: parseInt(process.env.PG_PORT || '5432'),
        user: process.env.PG_USER || 'root',
        password: process.env.PG_PASSWORD_SECRET || 'secret',
        database: process.env.PG_DATABASE || 'pixelci'
    });
    await conn.connect();
    return conn;
}

// Inserts a row (keys are column names), ignoring it when the id already exists.
async function insertIgnore(conn, table, row) {
    const columns = Object.keys(row);
    const placeholders = columns.map((_, i) => '$' + (i + 1));
    await conn.query(
        `INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')})
         VALUES (${placeholders.join(', ')})
         ON CONFLICT ("id") DO NOTHING`,
        Object.values(row)
    );
}

// Clears any per-screen review decisions, returning the seeded builds to their pristine
// (unreviewed) state. E2E tests submit reviews against this shared seed data, so this must
// run before each test to keep runs isolated.
async function resetReviews(conn) {
    await conn.query(
        `UPDATE builds_screens
         SET "reviewStatus" = NULL, "reviewComment" = NULL, "reviewedById" = NULL, "reviewedAt" = NULL
         WHERE "appId" = $1`,
        [APP_ID]
    );
}

function buildRow(id, branchId, createdAt, commitHash, commitSubject, ciJobId, status, approvedById, approvedAt) {
    return {
        id,
        appId: APP_ID,
        branchId,
        createdAt: new Date(createdAt),
        commitHash,
        commitSubject,
        commitAuthor: 'Test User',
        ciJobId,
        ciReadTokenHashes: '[]',
        status,
        approvedById,
        approvedAt: approvedAt ? new Date(approvedAt) : null
    };
}

function buildScreenRow(id, buildId, screenId, matchedBuildId, approvalBuildId, status) {
    return { id, appId: APP_ID, buildId, screenId, matchedBuildId, approvalBuildId, status, storageStatus: 'stored' };
}

async function seedDatabase() {
    const conn = await connect();

    await insertIgnore(conn, 'vcsIntegrations', {
        id: ZERO_ID,
        name: 'Test VCS',
        platform: 'gitlab',
        config: JSON.stringify({ url: 'https://git.example', clientId: 'client-id', clientSecret: sealSecret('client-secret') })
    });

    await insertIgnore(conn, 'users', {
        id: ZERO_ID,
        vcsId: ZERO_ID,
        vcsUserId: ZERO_ID,
        name: 'E2E Test User',
        isAdmin: true,
        createdAt: new Date(),
        lastLoginAt: new Date()
    });

    await insertIgnore(conn, 'apps', {
        id: APP_ID,
        vcsId: ZERO_ID,
        projectPath: 'test/project',
        defaultBranchId: MAIN_BRANCH_ID,
        name: 'E2E Test App'
    });

    await insertIgnore(conn, 'branches', { id: MAIN_BRANCH_ID, appId: APP_ID, name: 'main' });
    await insertIgnore(conn, 'branches', { id: FEAT_BRANCH_ID, appId: APP_ID, name: 'feature/redesign' });

    await insertIgnore(conn, 'screens', { id: SCREEN_HOMEPAGE_ID, appId: APP_ID, name: 'Homepage' });
    await insertIgnore(conn, 'screens', { id: SCREEN_DASHBOARD_ID, appId: APP_ID, name: 'Dashboard' });
    await insertIgnore(conn, 'screens', { id: SCREEN_SETTINGS_ID, appId: APP_ID, name: 'Settings' });
    await insertIgnore(conn, 'screens', { id: SCREEN_LOGIN_ID, appId: APP_ID, name: 'Login' });

    // ── Build 003: main, "changes approved", Jan 10 ── first build, just Homepage
    await insertIgnore(
        conn,
        'builds',
        buildRow(
            BUILD_003_ID,
            MAIN_BRANCH_ID,
            '2025-01-10T10:00:00Z',
            'a1b2c3d',
            'Initial layout',
            '100',
            'changes approved',
            ZERO_ID,
            '2025-01-10T10:30:00Z'
        )
    );
    // Homepage (no changes - baseline)
    await insertIgnore(conn, 'builds_screens', buildScreenRow(BS_020, BUILD_003_ID, SCREEN_HOMEPAGE_ID, null, null, 'no changes'));

    // ── Build 004: main, "changes approved", Jan 15 ── adds Dashboard and Settings
    await insertIgnore(
        conn,
        'builds',
        buildRow(
            BUILD_004_ID,
            MAIN_BRANCH_ID,
            '2025-01-15T14:00:00Z',
            'e4f5a6b',
            'Add dashboard and settings',
            '101',
            'changes approved',
            ZERO_ID,
            '2025-01-15T14:30:00Z'
        )
    );
    await insertIgnore(conn, 'builds_screens', buildScreenRow(BS_021, BUILD_004_ID, SCREEN_HOMEPAGE_ID, BUILD_003_ID, null, 'no changes'));
    await insertIgnore(conn, 'builds_screens', buildScreenRow(BS_022, BUILD_004_ID, SCREEN_DASHBOARD_ID, null, null, 'no changes'));
    await insertIgnore(conn, 'builds_screens', buildScreenRow(BS_023, BUILD_004_ID, SCREEN_SETTINGS_ID, null, null, 'no changes'));

    // ── Build 005: feature/redesign, "changes approved", Jan 18 ── Homepage changed, Dashboard and Settings unchanged
    await insertIgnore(
        conn,
        'builds',
        buildRow(
            BUILD_005_ID,
            FEAT_BRANCH_ID,
            '2025-01-18T09:00:00Z',
            'c7d8e9f',
            'Update homepage styles',
            '102',
            'changes approved',
            ZERO_ID,
            '2025-01-18T09:30:00Z'
        )
    );
    // Homepage (approved after review), Dashboard (no changes), Settings (no changes)
    await insertIgnore(conn, 'builds_screens', buildScreenRow(BS_024, BUILD_005_ID, SCREEN_HOMEPAGE_ID, null, BUILD_005_ID, 'changes approved'));
    await insertIgnore(conn, 'builds_screens', buildScreenRow(BS_025, BUILD_005_ID, SCREEN_DASHBOARD_ID, BUILD_004_ID, null, 'no changes'));
    await insertIgnore(conn, 'builds_screens', buildScreenRow(BS_026, BUILD_005_ID, SCREEN_SETTINGS_ID, BUILD_004_ID, null, 'no changes'));

    // ── Build 006: main, "no changes", Jan 20 ──
    await insertIgnore(
        conn,
        'builds',
        buildRow(BUILD_006_ID, MAIN_BRANCH_ID, '2025-01-20T16:00:00Z', 'b2c3d4e', 'Fix responsive breakpoints', '103', 'no changes', null, null)
    );
    await insertIgnore(conn, 'builds_screens', buildScreenRow(BS_027, BUILD_006_ID, SCREEN_HOMEPAGE_ID, BUILD_004_ID, null, 'no changes'));
    await insertIgnore(conn, 'builds_screens', buildScreenRow(BS_028, BUILD_006_ID, SCREEN_DASHBOARD_ID, BUILD_004_ID, null, 'no changes'));
    await insertIgnore(conn, 'builds_screens', buildScreenRow(BS_029, BUILD_006_ID, SCREEN_SETTINGS_ID, BUILD_004_ID, null, 'no changes'));

    // ── Build 007: feature/redesign, "needs review", Jan 22 ── Homepage changed, Dashboard/Settings unchanged, Login is new
    await insertIgnore(
        conn,
        'builds',
        buildRow(BUILD_007_ID, FEAT_BRANCH_ID, '2025-01-22T11:00:00Z', 'f0a1b2c', 'Redesign login page', '104', 'needs review', null, null)
    );
    await insertIgnore(conn, 'builds_screens', buildScreenRow(BS_02A, BUILD_007_ID, SCREEN_HOMEPAGE_ID, null, null, 'needs review'));
    await insertIgnore(conn, 'builds_screens', buildScreenRow(BS_02B, BUILD_007_ID, SCREEN_DASHBOARD_ID, BUILD_004_ID, null, 'no changes'));
    await insertIgnore(conn, 'builds_screens', buildScreenRow(BS_02C, BUILD_007_ID, SCREEN_SETTINGS_ID, BUILD_004_ID, null, 'no changes'));
    await insertIgnore(conn, 'builds_screens', buildScreenRow(BS_02D, BUILD_007_ID, SCREEN_LOGIN_ID, null, null, 'new'));

    // Make re-seeding idempotent w.r.t. reviews: a persisted local DB may retain decisions
    // from a prior run, and ON CONFLICT DO NOTHING above won't overwrite them.
    await resetReviews(conn);

    await conn.end();
    console.log('Database seeded.');
}

async function seedS3() {
    const s3 = new S3Client({
        endpoint: process.env.S3_ENDPOINT || 'http://localhost:29444',
        region: process.env.S3_REGION || 'us-east-1',
        forcePathStyle: true,
        credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY_ID || 'AKIAIOSFODNN7EXAMPLE',
            secretAccessKey: process.env.S3_ACCESS_SECRET || 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
        }
    });

    const bucket = process.env.S3_BUCKET || 'pixelci';

    // Ensure bucket exists
    try {
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (err) {
        if (err.name !== 'BucketAlreadyExists' && err.name !== 'BucketAlreadyOwnedByYou') throw err;
    }

    const uploads = [
        // ── Build 003: Homepage (finder-1) ──
        { key: `screens/${APP_ID}/${BUILD_003_ID}/${SCREEN_HOMEPAGE_ID}.png`, body: FINDER_1 },

        // ── Build 004: Homepage (finder-1), Dashboard (finder-2), Settings (finder-2-changed) ──
        { key: `screens/${APP_ID}/${BUILD_004_ID}/${SCREEN_HOMEPAGE_ID}.png`, body: FINDER_1 },
        { key: `screens/${APP_ID}/${BUILD_004_ID}/${SCREEN_DASHBOARD_ID}.png`, body: FINDER_2 },
        { key: `screens/${APP_ID}/${BUILD_004_ID}/${SCREEN_SETTINGS_ID}.png`, body: FINDER_2_CHANGED },

        // ── Build 005: Homepage (finder-1-changed), Dashboard (finder-2), Settings (finder-2-changed) ──
        { key: `screens/${APP_ID}/${BUILD_005_ID}/${SCREEN_HOMEPAGE_ID}.png`, body: FINDER_1_CHANGED },
        { key: `screens/${APP_ID}/${BUILD_005_ID}/${SCREEN_DASHBOARD_ID}.png`, body: FINDER_2 },
        { key: `screens/${APP_ID}/${BUILD_005_ID}/${SCREEN_SETTINGS_ID}.png`, body: FINDER_2_CHANGED },

        // ── Build 006: Homepage (finder-1), Dashboard (finder-2), Settings (finder-2-changed) ──
        { key: `screens/${APP_ID}/${BUILD_006_ID}/${SCREEN_HOMEPAGE_ID}.png`, body: FINDER_1 },
        { key: `screens/${APP_ID}/${BUILD_006_ID}/${SCREEN_DASHBOARD_ID}.png`, body: FINDER_2 },
        { key: `screens/${APP_ID}/${BUILD_006_ID}/${SCREEN_SETTINGS_ID}.png`, body: FINDER_2_CHANGED },

        // ── Build 007: Homepage (finder-1-changed), Dashboard (finder-2), Settings (finder-2-changed), Login (finder-2-changed-2) ──
        { key: `screens/${APP_ID}/${BUILD_007_ID}/${SCREEN_HOMEPAGE_ID}.png`, body: FINDER_1_CHANGED },
        { key: `screens/${APP_ID}/${BUILD_007_ID}/${SCREEN_DASHBOARD_ID}.png`, body: FINDER_2 },
        { key: `screens/${APP_ID}/${BUILD_007_ID}/${SCREEN_SETTINGS_ID}.png`, body: FINDER_2_CHANGED },
        { key: `screens/${APP_ID}/${BUILD_007_ID}/${SCREEN_LOGIN_ID}.png`, body: FINDER_2_CHANGED_2 },

        // ── Diff image for Build 007's Homepage (needs review) ──
        { key: `screens/${APP_ID}/${BUILD_007_ID}/${SCREEN_HOMEPAGE_ID}.diff.png`, body: FINDER_1_DIFF }
    ];

    await Promise.all(
        uploads.map(({ key, body }) => s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'image/png' })))
    );

    console.log('S3 seeded with test images.');
}

async function main() {
    // `--reset-reviews` is a fast path used between E2E tests to undo review decisions
    // without re-running the full seed (DB inserts + S3 uploads).
    if (process.argv.includes('--reset-reviews')) {
        const conn = await connect();
        await resetReviews(conn);
        await conn.end();
        console.log('E2E review state reset.');
        return;
    }

    await seedDatabase();
    await seedS3();
    console.log('E2E seed complete.');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
