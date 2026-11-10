import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isDeadlockError } from '../../src/controllers/Builds.controller';

describe('isDeadlockError', () => {
    it('detects mysql2 deadlock errors by errno, code or message', () => {
        assert.equal(isDeadlockError({ errno: 1213 }), true);
        assert.equal(isDeadlockError({ code: 'ER_LOCK_DEADLOCK' }), true);
        assert.equal(isDeadlockError(new Error('Deadlock found when trying to get lock; try restarting transaction')), true);
    });

    it('follows the cause chain', () => {
        assert.equal(isDeadlockError(new Error('wrapped', { cause: { errno: 1213 } })), true);
    });

    it('ignores other errors', () => {
        assert.equal(isDeadlockError({ errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' }), false);
        assert.equal(isDeadlockError(new Error('boom')), false);
        assert.equal(isDeadlockError(undefined), false);
    });
});
