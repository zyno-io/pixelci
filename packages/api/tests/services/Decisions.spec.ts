import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IDecisionCandidate, pickDecision } from '../../src/services/Decisions';

const cand = (id: string, kind: 'approved' | 'rejected', toImageBuildId: string | null, toHash: string | null = null): IDecisionCandidate => ({
    id,
    kind,
    toImageBuildId,
    toHash
});

/** A matcher over a fixed set of "equal" image builds, recording each comparison it was asked for. */
const matcher = (equal: string[]) => {
    const calls: string[] = [];
    return { calls, match: async (id: string) => (calls.push(id), equal.includes(id)) };
};

describe('pickDecision', () => {
    it('matches by hash without a pixel comparison', async () => {
        const m = matcher([]);
        const c = cand('d1', 'approved', 'b1', 'h1');
        assert.equal(await pickDecision([c], { hash: 'h1' }, m.match), c);
        assert.deepEqual(m.calls, []);
    });

    it('falls back to a pixel comparison when the hashes differ or are missing', async () => {
        const m = matcher(['b1']);
        const c = cand('d1', 'approved', 'b1', 'h1');
        assert.equal(await pickDecision([c], { hash: 'other' }, m.match), c);
        assert.equal(await pickDecision([c], { hash: null }, m.match), c);
        assert.equal(await pickDecision([cand('d2', 'approved', 'b2')], { hash: null }, m.match), undefined);
    });

    it('the newest matching decision wins', async () => {
        const m = matcher(['b1', 'b2']);
        const newer = cand('d2', 'rejected', 'b2');
        const older = cand('d1', 'approved', 'b1');
        assert.equal(await pickDecision([newer, older], { hash: null }, m.match), newer);
        assert.equal(await pickDecision([older, newer], { hash: null }, m.match), older);
    });

    it('a rejection newer than every matching approval blocks; an approval newer than a rejection wins', async () => {
        const m = matcher(['b1']);
        const reject = cand('d2', 'rejected', 'b1');
        const approve = cand('d1', 'approved', 'b1');
        assert.equal((await pickDecision([reject, approve], { hash: null }, m.match))?.kind, 'rejected');
        assert.equal((await pickDecision([approve, reject], { hash: null }, m.match))?.kind, 'approved');
    });

    it('skips non-matching decisions', async () => {
        const m = matcher(['b1']);
        const c = await pickDecision([cand('d3', 'rejected', 'b9'), cand('d2', 'approved', 'b1')], { hash: null }, m.match);
        assert.equal(c?.id, 'd2');
    });

    it('caches comparisons per to-image', async () => {
        const m = matcher([]);
        await pickDecision(
            [cand('d3', 'approved', 'b1', 'x'), cand('d2', 'rejected', 'b1', 'y'), cand('d1', 'approved', 'b1', 'z')],
            { hash: 'h' },
            m.match
        );
        assert.deepEqual(m.calls, ['b1']);
    });

    it('an exhausted budget with an unchecked candidate of the other kind gives no answer', async () => {
        const m = matcher(['b2']);
        // d3 (a newer rejection) can't be checked; d2 matches but is an approval, which d3 might outrank
        assert.equal(await pickDecision([cand('d3', 'rejected', 'b1'), cand('d2', 'approved', 'b2')], { hash: null }, m.match, 0), undefined);
    });

    it('an exhausted budget with an unchecked candidate of the same kind is fine when a later one matches by hash', async () => {
        const m = matcher([]);
        const hit = cand('d1', 'approved', 'b2', 'h');
        assert.equal(await pickDecision([cand('d3', 'approved', 'b1', 'other'), hit], { hash: 'h' }, m.match, 0), hit);
    });

    it('spends at most the budget on comparisons', async () => {
        const m = matcher([]);
        const cands = Array.from({ length: 10 }, (_, i) => cand(`d${i}`, 'approved', `b${i}`));
        await pickDecision(cands, { hash: null }, m.match, 4);
        assert.equal(m.calls.length, 4);
    });

    it('a removal matches only removal decisions', async () => {
        const m = matcher(['b1']);
        const removal = cand('d1', 'approved', null);
        assert.equal(await pickDecision([cand('d2', 'approved', 'b1'), removal], 'absent', m.match), removal);
        assert.deepEqual(m.calls, []);
    });

    it('an upload never matches a removal decision', async () => {
        const m = matcher(['b1']);
        assert.equal(await pickDecision([cand('d1', 'approved', null)], { hash: null }, m.match), undefined);
    });
});
