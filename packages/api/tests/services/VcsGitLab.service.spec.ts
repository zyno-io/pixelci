import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VcsGitLabService } from '../../src/services/VcsGitLab.service';

describe('rerunTargets', () => {
    const svc = new VcsGitLabService({ url: 'https://gitlab.example.com' } as never, { info() {}, warn() {}, error() {} } as never);
    it('retries each distinct job', () => {
        assert.deepEqual(svc.rerunTargets(['11', '12', '13']), ['11', '12', '13']);
        assert.deepEqual(svc.rerunTargets(['11', '12', '11']), ['11', '12']);
    });
});
