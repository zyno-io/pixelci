import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { PNG } from 'pngjs/browser';

// pixelmatch is ESM-only and requires dynamic import. Monkey-patch lodash.memoize
// before requiring the service so its module-level memoize() call uses our mock.
const mockPixelmatch = (img1: Uint8Array, img2: Uint8Array, output: Uint8Array | null, width: number, height: number) => {
    let diffCount = 0;
    for (let i = 0; i < width * height; i++) {
        const idx = i << 2;
        if (img1[idx] !== img2[idx] || img1[idx + 1] !== img2[idx + 1] || img1[idx + 2] !== img2[idx + 2]) {
            diffCount++;
            if (output) {
                output[idx] = 255;
                output[idx + 1] = 0;
                output[idx + 2] = 0;
                output[idx + 3] = 255;
            }
        }
    }
    return diffCount;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lodash = require('lodash');
const originalMemoize = lodash.memoize;
lodash.memoize = () => () => Promise.resolve(mockPixelmatch);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PixelMatchService } = require('../../src/services/PixelMatch.service');

// Restore after module is loaded
lodash.memoize = originalMemoize;

function createPng(width: number, height: number, fill: [number, number, number, number]): Buffer {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (width * y + x) << 2;
            png.data[idx] = fill[0];
            png.data[idx + 1] = fill[1];
            png.data[idx + 2] = fill[2];
            png.data[idx + 3] = fill[3];
        }
    }
    return PNG.sync.write(png);
}

// white canvas with a black rectangle
function createPngWithRect(width: number, height: number, rx: number, ry: number, rw: number, rh: number): Buffer {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (width * y + x) << 2;
            const v = x >= rx && x < rx + rw && y >= ry && y < ry + rh ? 0 : 255;
            png.data[idx] = v;
            png.data[idx + 1] = v;
            png.data[idx + 2] = v;
            png.data[idx + 3] = 255;
        }
    }
    return PNG.sync.write(png);
}

function createMockLogger() {
    return {
        info: mock.fn(),
        error: mock.fn(),
        warn: mock.fn(),
        debug: mock.fn()
    } as any;
}

describe('PixelMatchService', () => {
    it('should report no differences for identical images', async () => {
        const service = new PixelMatchService(createMockLogger());

        const img = createPng(4, 4, [255, 0, 0, 255]);
        const result = await service.getDiff(img, img);

        assert.equal(result.diffPixels, 0);
        assert.equal(result.diffPct, 0);
        assert.equal(result.totalPixels, 16);
    });

    it('should detect differences between images', async () => {
        const service = new PixelMatchService(createMockLogger());

        const red = createPng(4, 4, [255, 0, 0, 255]);
        const blue = createPng(4, 4, [0, 0, 255, 255]);
        const result = await service.getDiff(red, blue);

        assert.equal(result.diffPixels, 16);
        assert.equal(result.diffPct, 100);
        assert.equal(result.totalPixels, 16);
    });

    it('should return a valid diff PNG', async () => {
        const service = new PixelMatchService(createMockLogger());

        const red = createPng(4, 4, [255, 0, 0, 255]);
        const blue = createPng(4, 4, [0, 0, 255, 255]);
        const result = await service.getDiff(red, blue);

        const diffPng = result.getDiffPng();
        assert.ok(diffPng instanceof Uint8Array);

        const parsed = PNG.sync.read(Buffer.from(diffPng));
        assert.equal(parsed.width, 4);
        assert.equal(parsed.height, 4);
    });

    it('should calculate correct diff percentage for partial differences', async () => {
        const service = new PixelMatchService(createMockLogger());

        const img1 = new PNG({ width: 4, height: 4 });
        const img2 = new PNG({ width: 4, height: 4 });
        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
                const idx = (4 * y + x) << 2;
                img1.data[idx] = 255;
                img1.data[idx + 1] = 0;
                img1.data[idx + 2] = 0;
                img1.data[idx + 3] = 255;
                img2.data[idx] = 255;
                img2.data[idx + 1] = 0;
                img2.data[idx + 2] = 0;
                img2.data[idx + 3] = 255;
            }
        }
        for (let y = 2; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
                const idx = (4 * y + x) << 2;
                img2.data[idx] = 0;
                img2.data[idx + 1] = 0;
                img2.data[idx + 2] = 255;
            }
        }

        const buf1 = PNG.sync.write(img1);
        const buf2 = PNG.sync.write(img2);
        const result = await service.getDiff(buf1, buf2);

        assert.equal(result.diffPixels, 8);
        assert.equal(result.diffPct, 50);
        assert.equal(result.totalPixels, 16);
    });

    it('should log diff metrics', async () => {
        const logger = createMockLogger();
        const service = new PixelMatchService(logger);

        const img = createPng(4, 4, [255, 0, 0, 255]);
        await service.getDiff(img, img);

        assert.equal(logger.info.mock.callCount(), 1);
        const [message, data] = logger.info.mock.calls[0].arguments;
        assert.equal(message, 'Diff completed');
        assert.equal(data.sizesDiffer, false);
        assert.equal(data.totalPixels, 16);
        assert.equal(data.diffPixels, 0);
        assert.equal(data.diffPct, 0);
    });

    it('should handle images with different sizes by normalizing to max dimensions', async () => {
        const service = new PixelMatchService(createMockLogger());

        const small = createPng(2, 2, [255, 0, 0, 255]);
        const large = createPng(4, 4, [255, 0, 0, 255]);
        const result = await service.getDiff(small, large);

        // canvas is 4x4 = 16 pixels; the 2x2 overlap matches, but the padded area differs
        assert.equal(result.totalPixels, 16);
        assert.ok(result.diffPixels > 0);
        assert.ok(result.diffPct > 0);

        const diffPng = result.getDiffPng();
        const parsed = PNG.sync.read(Buffer.from(diffPng));
        assert.equal(parsed.width, 4);
        assert.equal(parsed.height, 4);
    });

    it('should report sizesDiffer in log when images have different sizes', async () => {
        const logger = createMockLogger();
        const service = new PixelMatchService(logger);

        const small = createPng(2, 2, [255, 0, 0, 255]);
        const large = createPng(4, 4, [255, 0, 0, 255]);
        await service.getDiff(small, large);

        const [message, data] = logger.info.mock.calls[0].arguments;
        assert.equal(message, 'Diff completed');
        assert.equal(data.sizesDiffer, true);
    });

    describe('shift tolerance', () => {
        const base = createPngWithRect(12, 12, 3, 3, 4, 4);
        const shifted1 = createPngWithRect(12, 12, 4, 3, 4, 4);
        const shifted2 = createPngWithRect(12, 12, 5, 3, 4, 4);

        it('should count a 1px shift as a diff when tolerance is disabled', async () => {
            const service = new PixelMatchService(createMockLogger());
            const result = await service.getDiff(base, shifted1, 0.2, 0);
            assert.equal(result.diffPixels, 8);
            assert.equal(result.shiftTolerantPixels, 0);
        });

        it('should forgive a 1px shift within tolerance and paint it yellow', async () => {
            const service = new PixelMatchService(createMockLogger());
            const result = await service.getDiff(base, shifted1, 0.2, 1);
            assert.equal(result.diffPixels, 0);
            assert.equal(result.diffPct, 0);
            assert.equal(result.shiftTolerantPixels, 8);

            const parsed = PNG.sync.read(Buffer.from(result.getDiffPng()));
            const idx = (12 * 4 + 3) << 2; // left edge of the original rect
            assert.deepEqual([...parsed.data.subarray(idx, idx + 4)], [255, 255, 0, 255]);
        });

        it('should still flag a shift larger than the tolerance', async () => {
            const service = new PixelMatchService(createMockLogger());
            const result = await service.getDiff(base, shifted2, 0.2, 1);
            assert.ok(result.diffPixels > 0);
            assert.equal((await service.getDiff(base, shifted2, 0.2, 2)).diffPixels, 0);
        });

        it('should not forgive added or recoloured content', async () => {
            const service = new PixelMatchService(createMockLogger());
            const blank = createPng(12, 12, [255, 255, 255, 255]);
            const added = await service.getDiff(blank, base, 0.2, 2);
            assert.equal(added.diffPixels, 16);

            // a recolour the old YIQ-based pass forgave with no shift involved (red -> amber)
            const recolour = (from: [number, number, number], to: [number, number, number]) => {
                const make = (c: [number, number, number]) => {
                    const png = PNG.sync.read(blank);
                    for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) png.data.set([...c, 255], (12 * y + x) << 2);
                    return PNG.sync.write(png);
                };
                return service.getDiff(make(from), make(to), 0.2, 1);
            };
            assert.equal((await recolour([0xef, 0x44, 0x44], [0xca, 0x8a, 0x04])).diffPixels, 16);
            assert.equal((await recolour([0xf9, 0x73, 0x16], [0xec, 0x48, 0x99])).diffPixels, 16);

            // a transparent background turning white is a change, not a shift
            const transparent = createPng(12, 12, [0, 0, 0, 0]);
            assert.equal((await service.getDiff(transparent, blank, 0.2, 2)).diffPixels, 144);

            const red = PNG.sync.read(base);
            for (let i = 0; i < red.data.length; i += 4) if (red.data[i] === 0) red.data[i] = 255;
            const recoloured = await service.getDiff(base, PNG.sync.write(red), 0.2, 2);
            assert.equal(recoloured.diffPixels, 16);
        });
    });
});
