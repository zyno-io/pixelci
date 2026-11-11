import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from './error.js';
import { parseShard, parseTimeoutMs, shardWarning } from './options.js';

describe('parseTimeoutMs', () => {
    it('defaults to 15 minutes', () => {
        assert.equal(parseTimeoutMs({}), 15 * 60_000);
        assert.equal(parseTimeoutMs({ PIXELCI_TIMEOUT_MINUTES: ' ' }), 15 * 60_000);
    });

    it('accepts 1..120', () => {
        assert.equal(parseTimeoutMs({ PIXELCI_TIMEOUT_MINUTES: '1' }), 60_000);
        assert.equal(parseTimeoutMs({ PIXELCI_TIMEOUT_MINUTES: '120' }), 120 * 60_000);
        assert.equal(parseTimeoutMs({ PIXELCI_TIMEOUT_MINUTES: '2.5' }), 150_000);
    });

    for (const bad of ['0', '0.5', '121', '-1', 'abc', '10m', 'NaN', 'Infinity']) {
        it(`rejects '${bad}'`, () => {
            assert.throws(() => parseTimeoutMs({ PIXELCI_TIMEOUT_MINUTES: bad }), AppError);
        });
    }
});

describe('parseShard', () => {
    it('is undefined when unset', () => {
        assert.equal(parseShard({}), undefined);
    });

    it('parses i/n', () => {
        assert.deepEqual(parseShard({ PIXELCI_SHARD: '2/4' }), { index: 2, total: 4 });
        assert.deepEqual(parseShard({ PIXELCI_SHARD: '64/64' }), { index: 64, total: 64 });
        assert.deepEqual(parseShard({ PIXELCI_SHARD: '1/1' }), { index: 1, total: 1 });
    });

    for (const bad of ['0/4', '5/4', '1/65', '1', '1/', '/4', 'a/b', '1/2/3', '-1/4', '1.5/4', '0/0']) {
        it(`rejects '${bad}'`, () => {
            assert.throws(() => parseShard({ PIXELCI_SHARD: bad }), AppError);
        });
    }
});

describe('shardWarning', () => {
    it('warns when CI_NODE_TOTAL > 1 and PIXELCI_SHARD is unset', () => {
        assert.match(shardWarning({ CI_NODE_TOTAL: '3' })!, /PIXELCI_SHARD/);
    });

    it('is silent otherwise', () => {
        assert.equal(shardWarning({ CI_NODE_TOTAL: '1' }), undefined);
        assert.equal(shardWarning({}), undefined);
        assert.equal(shardWarning({ CI_NODE_TOTAL: '3', PIXELCI_SHARD: '1/3' }), undefined);
        assert.equal(shardWarning({ CI_NODE_TOTAL: 'x' }), undefined);
    });
});
