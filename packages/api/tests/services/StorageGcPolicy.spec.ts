import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppConfig } from '../../src/config';
import { parseScreensKey, S3Service } from '../../src/services/S3.service';
import { classifyBuildObjects, type IBuildFacts, type IOwnRow } from '../../src/services/storage/StorageGcPolicy';
import { resolveStorageGcSettings } from '../../src/services/storage/StorageGcSettings';

const APP = 'aaaaaaaa-0000-4000-8000-000000000001';
const BUILD = 'bbbbbbbb-0000-4000-8000-000000000001';
const SCREEN = 'cccccccc-0000-4000-8000-000000000001';
const SCREEN_2 = 'cccccccc-0000-4000-8000-000000000002';
const ROW = 'dddddddd-0000-4000-8000-000000000001';
const OTHER_BUILD = 'bbbbbbbb-0000-4000-8000-000000000002';

const s3 = new S3Service({ S3_BUCKET: 'x' } as AppConfig);
const upload = (screen = SCREEN) => s3.getPathForScreen(APP, BUILD, screen);
const diff = (screen = SCREEN) => s3.getPathForDiff(APP, BUILD, screen);
const thumb = (screen = SCREEN, row = ROW) => s3.getPathForThumbnail(APP, BUILD, screen, row);

const NOW = new Date('2026-11-18T12:00:00Z');
const OLD = new Date('2026-11-01T00:00:00Z');
const HOUR = 3_600_000;

function row(patch: Partial<IOwnRow> = {}): IOwnRow {
    return { id: ROW, isRemoved: false, storageStatus: 'stored', status: 'needs review', matchedBuildId: null, ...patch };
}

function facts(patch: Partial<{ [K in keyof IBuildFacts]: unknown }> & { rows?: Record<string, IOwnRow> } = {}): IBuildFacts {
    const { rows, ...rest } = patch;
    return {
        appId: APP,
        buildId: BUILD,
        build: { status: 'needs review' },
        ownRows: new Map(Object.entries(rows ?? {})),
        inboundMatched: new Set(),
        inboundBase: new Set(),
        decisionScreens: new Set(),
        ...rest
    } as IBuildFacts;
}

const obj = (key: string, lastModified: Date | undefined = OLD) => ({ key, lastModified, size: 10 });
const classify = (keys: string[], f: IBuildFacts, graceMs = 24 * HOUR) =>
    classifyBuildObjects(
        keys.map(k => obj(k)),
        f,
        { now: NOW, graceMs }
    );
const garbageKeys = (c: ReturnType<typeof classify>) => c.garbage.map(g => g.key).sort();

describe('parseScreensKey', () => {
    it('round-trips the S3Service key shapes', () => {
        assert.deepEqual(parseScreensKey(upload()), { appId: APP, buildId: BUILD, screenId: SCREEN, kind: 'upload' });
        assert.deepEqual(parseScreensKey(diff()), { appId: APP, buildId: BUILD, screenId: SCREEN, kind: 'diff' });
        assert.deepEqual(parseScreensKey(thumb()), { appId: APP, buildId: BUILD, screenId: SCREEN, kind: 'thumb', buildScreenId: ROW });
    });

    it('rejects anything that is not exactly one of those shapes', () => {
        for (const key of [
            '',
            'screens/',
            `screens/${APP}/${BUILD}/`,
            `screens/${APP}/${BUILD}/${SCREEN}.jpg`,
            `screens/${APP}/${BUILD}/${SCREEN}.png.bak`,
            `screens/${APP}/${BUILD}/${SCREEN}.thumb.png`,
            `screens/${APP}/${BUILD}/${SCREEN}.nope.thumb.png`,
            `screens/${APP}/${BUILD}/sub/${SCREEN}.png`,
            `screens/${APP}/${BUILD}/${SCREEN.toUpperCase()}.png`,
            `other/${APP}/${BUILD}/${SCREEN}.png`,
            `/screens/${APP}/${BUILD}/${SCREEN}.png`,
            `screens/${APP}/${SCREEN}.png`
        ]) {
            assert.equal(parseScreensKey(key), null, key);
        }
    });
});

describe('classifyBuildObjects', () => {
    it('keeps an upload whose own row is stored (null status counts as stored)', () => {
        for (const storageStatus of ['stored', null] as const) {
            const c = classify([upload()], facts({ rows: { [SCREEN]: row({ storageStatus }) } }));
            assert.deepEqual(c.garbage, []);
            assert.equal(c.kept.ownRow, 1);
        }
    });

    it('deletes the upload of a pendingDeletion row that nothing points at', () => {
        const f = facts({ rows: { [SCREEN]: row({ storageStatus: 'pendingDeletion', status: 'no changes', matchedBuildId: OTHER_BUILD }) } });
        assert.deepEqual(garbageKeys(classify([upload()], f)), [upload()]);
    });

    it('keeps a pendingDeletion upload that a legacy chain still matches (A matched to B, B pendingDeletion)', () => {
        const f = facts({
            rows: { [SCREEN]: row({ storageStatus: 'pendingDeletion', status: 'no changes', matchedBuildId: OTHER_BUILD }) },
            inboundMatched: new Set([SCREEN])
        });
        const c = classify([upload()], f);
        assert.deepEqual(c.garbage, []);
        assert.equal(c.kept.matchedBy, 1);
    });

    it('keeps an upload that is the base image of a row, tombstones included', () => {
        const c = classify([upload()], facts({ inboundBase: new Set([SCREEN]) }));
        assert.deepEqual(c.garbage, []);
        assert.equal(c.kept.baseOf, 1);
    });

    it('keeps an upload that a decision uses, revoked or not, even when the build has no row for the screen any more', () => {
        const c = classify([upload()], facts({ decisionScreens: new Set([SCREEN]) }));
        assert.deepEqual(c.garbage, []);
        assert.equal(c.kept.decision, 1);
    });

    it('matches by screen: a reference to another screen does not keep this one', () => {
        const f = facts({ inboundMatched: new Set([SCREEN_2]), inboundBase: new Set([SCREEN_2]), decisionScreens: new Set([SCREEN_2]) });
        assert.deepEqual(garbageKeys(classify([upload()], f)), [upload()]);
    });

    it('deletes the upload of a tombstone row and of a screen with no row', () => {
        const f = facts({ rows: { [SCREEN]: row({ isRemoved: true }) } });
        assert.deepEqual(garbageKeys(classify([upload(), upload(SCREEN_2)], f)), [upload(), upload(SCREEN_2)].sort());
    });

    it('keeps a pendingDeletion upload when the row is not the auto-approved shape it should be', () => {
        for (const patch of [{ matchedBuildId: null }, { status: 'needs review' }, { status: null }] as const) {
            const f = facts({
                rows: { [SCREEN]: row({ storageStatus: 'pendingDeletion', status: 'no changes', matchedBuildId: OTHER_BUILD, ...patch }) }
            });
            const c = classify([upload()], f);
            assert.deepEqual(c.garbage, [], JSON.stringify(patch));
            assert.equal(c.kept.inconsistentPending, 1);
        }
    });

    it('keeps a thumbnail for as long as the row it was made for exists, and only for that row', () => {
        const stored = facts({ rows: { [SCREEN]: row() } });
        assert.deepEqual(classify([thumb()], stored).garbage, []);
        // a re-upload replaced the row: the old thumbnail is garbage
        assert.deepEqual(garbageKeys(classify([thumb(SCREEN, 'dddddddd-0000-4000-8000-0000000000ff')], stored)), [
            thumb(SCREEN, 'dddddddd-0000-4000-8000-0000000000ff')
        ]);
        // the row's upload went (pendingDeletion, nothing points at it) but the thumbnail endpoint still serves the row: it stays
        const pending = facts({ rows: { [SCREEN]: row({ storageStatus: 'pendingDeletion', status: 'no changes', matchedBuildId: OTHER_BUILD }) } });
        const c = classify([upload(), thumb()], pending);
        assert.deepEqual(garbageKeys(c), [upload()]);
        assert.equal(c.kept.thumbnail, 1);
        // no row at all, or a tombstone
        assert.deepEqual(garbageKeys(classify([thumb()], facts())), [thumb()]);
        assert.deepEqual(garbageKeys(classify([thumb()], facts({ rows: { [SCREEN]: row({ isRemoved: true }) } }))), [thumb()]);
    });

    it('keeps a diff while the own row exists (any storage status) or a matched row may fall back to it', () => {
        const pending = row({ storageStatus: 'pendingDeletion', status: 'no changes', matchedBuildId: OTHER_BUILD });
        assert.deepEqual(classify([diff()], facts({ rows: { [SCREEN]: pending } })).garbage, []);
        const legacy = classify([diff()], facts({ inboundMatched: new Set([SCREEN]) }));
        assert.deepEqual(legacy.garbage, []);
        assert.equal(legacy.kept.matchedBy, 1);
        // a decision keeps the upload, not the diff
        assert.deepEqual(garbageKeys(classify([diff()], facts({ decisionScreens: new Set([SCREEN]) }))), [diff()]);
        assert.deepEqual(garbageKeys(classify([diff()], facts({ rows: { [SCREEN]: row({ isRemoved: true }) } }))), [diff()]);
    });

    it('leaves young garbage (inside the grace period, or with no timestamp) for later', () => {
        const recent = obj(upload(), new Date(NOW.getTime() - 2 * HOUR));
        const undated = { key: upload(SCREEN_2), size: 10 };
        const c = classifyBuildObjects([recent, undated], facts(), { now: NOW, graceMs: 24 * HOUR });
        assert.deepEqual(c.garbage, []);
        assert.equal(c.young.length, 2);
        // the same object is garbage once it is older than the grace period
        assert.equal(classifyBuildObjects([recent], facts(), { now: NOW, graceMs: HOUR }).garbage.length, 1);
        // graceMs 0: anything not in the future
        assert.equal(classifyBuildObjects([recent], facts(), { now: NOW, graceMs: 0 }).garbage.length, 1);
    });

    it('never touches keys that are not recognised, or that belong to another build or app', () => {
        const keys = [
            `screens/${APP}/${BUILD}/notes.txt`,
            `screens/${APP}/${BUILD}/${SCREEN}.png.tmp`,
            s3.getPathForScreen(APP, OTHER_BUILD, SCREEN),
            s3.getPathForScreen('aaaaaaaa-0000-4000-8000-0000000000ff', BUILD, SCREEN),
            'elsewhere/file.png'
        ];
        const c = classify(keys, facts());
        assert.deepEqual(c.garbage, []);
        assert.deepEqual(c.young, []);
        assert.equal(c.unrecognized.length, keys.length);
    });

    it('skips every object when the build row is missing', () => {
        const c = classify([upload(), diff(), thumb()], facts({ build: null }));
        assert.deepEqual(c.garbage, []);
        assert.equal(c.unknownBuild, 3);
    });

    it('skips draft, processing, canceled and failed builds, and only acts on final statuses', () => {
        for (const status of ['draft', 'processing', 'canceled', 'failed', 'something new']) {
            const c = classify([upload(), diff(), thumb()], facts({ build: { status } }));
            assert.deepEqual(c.garbage, [], status);
            assert.equal(c.kept.buildNotFinal, 3, status);
        }
        for (const status of ['no changes', 'needs review', 'changes approved', 'changes rejected']) {
            assert.equal(classify([upload()], facts({ build: { status } })).garbage.length, 1, status);
        }
    });
});

describe('resolveStorageGcSettings', () => {
    const base = {
        STORAGE_GC_MODE: 'dry-run',
        STORAGE_GC_GRACE_HOURS: 24,
        STORAGE_GC_SWEEP_INTERVAL_HOURS: 24,
        STORAGE_GC_MAX_RUN_MINUTES: 10,
        STORAGE_GC_DELETE_UNKNOWN_APPS: false,
        APP_PURGE_AFTER_DAYS: 30
    };

    it('reads the defaults', () => {
        const s = resolveStorageGcSettings(base);
        assert.equal(s.mode, 'dry-run');
        assert.equal(s.graceMs, 24 * HOUR);
        assert.equal(s.sweepIntervalMs, 24 * HOUR);
        assert.equal(s.maxRunMs, 10 * 60_000);
        assert.equal(s.deleteUnknownApps, false);
        assert.equal(s.purgeAfterDays, 30);
        assert.deepEqual(s.warnings, []);
    });

    it('accepts the three modes, case and whitespace aside', () => {
        for (const mode of ['off', 'dry-run', 'delete'])
            assert.equal(resolveStorageGcSettings({ ...base, STORAGE_GC_MODE: ` ${mode.toUpperCase()} ` }).mode, mode);
    });

    it('falls back to dry-run, never delete, on an unknown mode', () => {
        const s = resolveStorageGcSettings({ ...base, STORAGE_GC_MODE: 'yes' });
        assert.equal(s.mode, 'dry-run');
        assert.equal(s.warnings.length, 1);
    });

    it('clamps the grace period to 6 hours and falls back on non-numbers', () => {
        const low = resolveStorageGcSettings({ ...base, STORAGE_GC_GRACE_HOURS: 1 });
        assert.equal(low.graceMs, 6 * HOUR);
        assert.equal(low.warnings.length, 1);
        const bad = resolveStorageGcSettings({ ...base, STORAGE_GC_GRACE_HOURS: Number.NaN });
        assert.equal(bad.graceMs, 24 * HOUR);
        assert.equal(bad.warnings.length, 1);
    });

    it('never reads a negative APP_PURGE_AFTER_DAYS as "purge now"', () => {
        const s = resolveStorageGcSettings({ ...base, APP_PURGE_AFTER_DAYS: -1 });
        assert.equal(s.purgeAfterDays, 30);
        assert.equal(s.warnings.length, 1);
    });

    it('lets APP_PURGE_AFTER_DAYS be 0 (the next run)', () => {
        const s = resolveStorageGcSettings({ ...base, APP_PURGE_AFTER_DAYS: 0 });
        assert.equal(s.purgeAfterDays, 0);
        assert.deepEqual(s.warnings, []);
    });
});
