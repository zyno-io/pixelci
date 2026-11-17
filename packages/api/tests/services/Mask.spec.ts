import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IMaskRect, MAX_MASKS, rasterizeMasks, resolveMasks, validateMasks } from '../../src/services/Mask';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rect = (n: number, x = 0, y = 0, width = 10, height = 10, label: string | null = null): IMaskRect => ({
    id: id(n),
    x,
    y,
    width,
    height,
    label
});

describe('validateMasks', () => {
    it('accepts valid masks and an empty list', () => {
        validateMasks([]);
        validateMasks([rect(1), rect(2, 5, 5, 1, 1, 'clock')]);
    });

    it('rejects a non-array, a non-object entry, and more than the cap', () => {
        assert.throws(() => validateMasks({}), /array/);
        assert.throws(() => validateMasks([null]), /object/);
        validateMasks(Array.from({ length: MAX_MASKS }, (_, i) => rect(i + 1)));
        assert.throws(() => validateMasks(Array.from({ length: MAX_MASKS + 1 }, (_, i) => rect(i + 1))), /at most 50/);
    });

    it('rejects non-integer, negative and zero geometry', () => {
        assert.throws(() => validateMasks([{ ...rect(1), x: 1.5 }]), /x must be/);
        assert.throws(() => validateMasks([{ ...rect(1), y: -1 }]), /y must be/);
        assert.throws(() => validateMasks([{ ...rect(1), width: 0 }]), /width must be/);
        assert.throws(() => validateMasks([{ ...rect(1), height: NaN }]), /height must be/);
        assert.throws(() => validateMasks([{ ...rect(1), width: '5' }]), /width must be/);
    });

    it('rejects masks that extend past 100 000 px', () => {
        validateMasks([rect(1, 99_990, 0, 10, 1)]);
        assert.throws(() => validateMasks([rect(1, 99_991, 0, 10, 1)]), /horizontally/);
        assert.throws(() => validateMasks([rect(1, 0, 99_991, 1, 10)]), /vertically/);
    });

    it('rejects bad and duplicate ids', () => {
        assert.throws(() => validateMasks([{ ...rect(1), id: 'nope' }]), /uuid/);
        assert.throws(() => validateMasks([rect(1), rect(1)]), /duplicate/);
    });

    it('limits labels to 80 characters', () => {
        validateMasks([rect(1, 0, 0, 1, 1, 'x'.repeat(80))]);
        assert.throws(() => validateMasks([rect(1, 0, 0, 1, 1, 'x'.repeat(81))]), /label/);
        assert.throws(() => validateMasks([{ ...rect(1), label: 5 }]), /label/);
    });
});

describe('resolveMasks', () => {
    const app = { masks: [rect(1)] };
    const screen = { masks: [rect(2)], inheritAppMasks: true };

    it('combines app masks with the screen masks', () => {
        assert.deepEqual(resolveMasks(app, screen), [rect(1), rect(2)]);
    });

    it('drops app masks when the screen opts out', () => {
        assert.deepEqual(resolveMasks(app, { ...screen, inheritAppMasks: false }), [rect(2)]);
    });

    it('handles missing screens and null columns', () => {
        assert.deepEqual(resolveMasks(app), [rect(1)]);
        assert.deepEqual(resolveMasks({ masks: null }, { masks: null, inheritAppMasks: true }), []);
    });
});

describe('rasterizeMasks', () => {
    it('returns null when nothing is masked', () => {
        assert.equal(rasterizeMasks([], 10, 10), null);
        assert.equal(rasterizeMasks([rect(1, 20, 20)], 10, 10), null);
    });

    it('rasterises row-major from the top-left', () => {
        const raster = rasterizeMasks([rect(1, 1, 2, 2, 1)], 4, 4)!;
        assert.equal(raster.maskedPixels, 2);
        assert.deepEqual([...raster.bitmap], [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
    });

    it('clips to the canvas and counts overlap once', () => {
        const raster = rasterizeMasks([rect(1, 0, 0, 4, 4), rect(2, 2, 2, 4, 4), rect(3, 8, 8, 50, 50)], 10, 10)!;
        assert.equal(raster.maskedPixels, 16 + 16 - 4 + 4);
    });
});
