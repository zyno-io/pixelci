import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppConfig } from '../../src/config';
import { instanceTolerances, resolveTolerances, validateToleranceOverrides, validateTolerances } from '../../src/services/Tolerance';

const config = Object.assign(new AppConfig(), {
    DEFAULT_PIXEL_MATCH_THRESHOLD: 0.2,
    DEFAULT_PIXEL_SHIFT_TOLERANCE: 1,
    DEFAULT_PIXEL_DIFF_PCT_THRESHOLD: 0.01
});
const none = { colorTolerance: null, shiftTolerance: null, diffPctTolerance: null };

describe('resolveTolerances', () => {
    it('maps instance config', () => {
        assert.deepEqual(instanceTolerances(config), { colorTolerance: 0.2, shiftTolerance: 1, diffPctTolerance: 0.01 });
    });

    it('falls back to the instance config when nothing is overridden', () => {
        assert.deepEqual(resolveTolerances(config, none), { colorTolerance: 0.2, shiftTolerance: 1, diffPctTolerance: 0.01 });
        assert.deepEqual(resolveTolerances(config, none, none), { colorTolerance: 0.2, shiftTolerance: 1, diffPctTolerance: 0.01 });
    });

    it('app overrides instance, screen overrides app, field-wise', () => {
        const app = { colorTolerance: 0.5, shiftTolerance: 3, diffPctTolerance: null };
        const screen = { colorTolerance: null, shiftTolerance: 0, diffPctTolerance: 5 };
        assert.deepEqual(resolveTolerances(config, app), { colorTolerance: 0.5, shiftTolerance: 3, diffPctTolerance: 0.01 });
        assert.deepEqual(resolveTolerances(config, app, screen), { colorTolerance: 0.5, shiftTolerance: 0, diffPctTolerance: 5 });
    });

    it('treats 0 as a real override, not as unset', () => {
        const app = { colorTolerance: 0, shiftTolerance: 0, diffPctTolerance: 0 };
        assert.deepEqual(resolveTolerances(config, app), { colorTolerance: 0, shiftTolerance: 0, diffPctTolerance: 0 });
    });
});

describe('validateToleranceOverrides', () => {
    it('accepts null, undefined, and in-range values (inclusive)', () => {
        validateToleranceOverrides({});
        validateToleranceOverrides(none);
        validateToleranceOverrides({ colorTolerance: 0, shiftTolerance: 0, diffPctTolerance: 0 });
        validateToleranceOverrides({ colorTolerance: 1, shiftTolerance: 5, diffPctTolerance: 100 });
    });

    it('rejects out-of-range and non-finite values', () => {
        for (const bad of [
            { colorTolerance: -0.1 },
            { colorTolerance: 1.1 },
            { colorTolerance: NaN },
            { colorTolerance: '0.5' as unknown as number },
            { shiftTolerance: -1 },
            { shiftTolerance: 6 },
            { shiftTolerance: 1.5 },
            { diffPctTolerance: -1 },
            { diffPctTolerance: 100.5 },
            { diffPctTolerance: Infinity }
        ]) {
            assert.throws(() => validateToleranceOverrides(bad), /must be/, JSON.stringify(bad));
        }
    });

    it('validateTolerances requires all three values', () => {
        validateTolerances({ colorTolerance: 0.2, shiftTolerance: 1, diffPctTolerance: 0.5 });
        assert.throws(() => validateTolerances({ colorTolerance: 0.2, shiftTolerance: 1 }), /diffPctTolerance is required/);
        assert.throws(() => validateTolerances({ colorTolerance: 0.2, shiftTolerance: null as unknown as number, diffPctTolerance: 1 }), /required/);
        assert.throws(() => validateTolerances({ colorTolerance: 2, shiftTolerance: 1, diffPctTolerance: 1 }), /colorTolerance/);
    });
});
