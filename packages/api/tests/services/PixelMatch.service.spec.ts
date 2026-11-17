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

        const diffPng = await result.getDiffPng();
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

        const diffPng = await result.getDiffPng();
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

            const parsed = PNG.sync.read(Buffer.from(await result.getDiffPng()));
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

    describe('masks', () => {
        const mask = (x: number, y: number, width: number, height: number, n = 1) => ({
            id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
            x,
            y,
            width,
            height,
            label: null
        });
        const white = createPng(10, 10, [255, 255, 255, 255]);

        it('should report no changed pixels for a change inside a mask', async () => {
            const service = new PixelMatchService(createMockLogger());
            const changed = createPngWithRect(10, 10, 2, 2, 3, 3);
            const result = await service.getDiff(white, changed, 0.2, 0, [mask(1, 1, 5, 5)]);
            assert.equal(result.diffPixels, 0);
            assert.equal(result.diffPct, 0);
            assert.equal(result.maskedPixels, 25);
            assert.equal((await service.getDiff(white, changed, 0.2, 0)).diffPixels, 9);
        });

        it('should exclude masked pixels from the percentage', async () => {
            const service = new PixelMatchService(createMockLogger());
            const changed = createPngWithRect(10, 10, 0, 5, 5, 2); // 10 changed pixels in rows 5-6
            const result = await service.getDiff(white, changed, 0.2, 0, [mask(0, 0, 10, 5)]);
            assert.equal(result.totalPixels, 100);
            assert.equal(result.maskedPixels, 50);
            assert.equal(result.diffPixels, 10);
            assert.equal(result.diffPct, 20);
        });

        it('should count overlapping masks once and clip them to the canvas', async () => {
            const service = new PixelMatchService(createMockLogger());
            const result = await service.getDiff(white, white, 0.2, 0, [
                mask(0, 0, 4, 4, 1),
                mask(2, 2, 4, 4, 2),
                mask(8, 8, 50, 50, 3),
                mask(20, 20, 5, 5, 4)
            ]);
            assert.equal(result.maskedPixels, 16 + 16 - 4 + 4);
        });

        it('should report 0% when the whole screen is masked', async () => {
            const service = new PixelMatchService(createMockLogger());
            const result = await service.getDiff(white, createPngWithRect(10, 10, 0, 0, 10, 10), 0.2, 1, [mask(0, 0, 10, 10)]);
            assert.equal(result.diffPixels, 0);
            assert.equal(result.diffPct, 0);
            assert.equal(result.maskedPixels, 100);
        });

        it('should not let masked neighbours excuse an unmasked pixel', async () => {
            const service = new PixelMatchService(createMockLogger());
            const a = createPngWithRect(10, 10, 5, 5, 1, 1);
            const b = createPngWithRect(10, 10, 6, 5, 1, 1);
            const unmasked = await service.getDiff(a, b, 0.2, 1);
            assert.equal(unmasked.diffPixels, 0);
            assert.equal(unmasked.shiftTolerantPixels, 2);

            const masked = await service.getDiff(a, b, 0.2, 1, [mask(6, 5, 1, 1)]);
            assert.equal(masked.diffPixels, 1);
        });

        it('should let a mask cover the padding when image sizes differ', async () => {
            const service = new PixelMatchService(createMockLogger());
            const taller = createPng(10, 12, [255, 255, 255, 255]);
            assert.equal((await service.getDiff(white, taller)).diffPixels, 20);
            const result = await service.getDiff(white, taller, 0.2, 0, [mask(0, 10, 10, 2)]);
            assert.equal(result.diffPixels, 0);
            assert.equal(result.maskedPixels, 20);
        });

        it('should tint the diff image only on masked pixels', async () => {
            const service = new PixelMatchService(createMockLogger());
            const other = createPngWithRect(10, 10, 6, 6, 2, 2);
            const plain = PNG.sync.read(Buffer.from(await (await service.getDiff(white, other, 0.2, 0)).getDiffPng()));
            const result = await service.getDiff(white, other, 0.2, 0, [mask(0, 0, 5, 5)]);
            const parsed = PNG.sync.read(Buffer.from(await result.getDiffPng()));
            const at = (png: PNG, x: number, y: number) => [...png.data.subarray((10 * y + x) << 2, ((10 * y + x) << 2) + 4)];
            for (let y = 0; y < 10; y++) {
                for (let x = 0; x < 10; x++) {
                    const masked = x < 5 && y < 5; // includes the line pixels (0,0) and (4,4)
                    if (!masked) {
                        assert.deepEqual(at(parsed, x, y), at(plain, x, y), `pixel ${x},${y} is untouched`);
                        continue;
                    }
                    // line pixels ((x + y) % 8 == 0): grey 70 at 60%; the rest: grey 128 at 40%; each composited over the untinted diff
                    const onLine = (x + y) % 8 === 0;
                    const grey = onLine ? 70 : 128;
                    const a = onLine ? 0.6 : 0.4;
                    const [r, g, bl, alpha] = at(plain, x, y);
                    const dstA = alpha / 255;
                    const outA = a + dstA * (1 - a);
                    const ch = (v: number) => Math.round((grey * a + v * dstA * (1 - a)) / outA);
                    assert.deepEqual(
                        at(parsed, x, y),
                        [ch(r), ch(g), ch(bl), Math.round(outA * 255)],
                        `pixel ${x},${y} is ${onLine ? 'a line' : 'tinted'}`
                    );
                    assert.ok(at(parsed, x, y)[3] >= 102, `pixel ${x},${y} is visible`);
                }
            }
            assert.deepEqual(at(parsed, 6, 6), [255, 0, 0, 255]); // a counted change keeps its colour
        });

        it('should be invariant to content under a mask, at every shift radius', async () => {
            const service = new PixelMatchService(createMockLogger());
            const size = 40;
            let seed = 12345;
            const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 256;

            // content that shifts next to the mask, plus a change that doesn't; the mask covers x 20..27, y 8..31
            const build = (shiftX: number, noise: boolean) => {
                const png = PNG.sync.read(createPng(size, size, [255, 255, 255, 255]));
                for (let y = 10; y < 18; y++) for (let x = 12 + shiftX; x < 20 + shiftX; x++) png.data.set([0, 0, 0, 255], (size * y + x) << 2);
                for (let y = 30; y < 34; y++) for (let x = 2; x < 6; x++) png.data.set([200, 30, 30, 255], (size * y + x) << 2);
                if (noise) {
                    for (let y = 8; y < 32; y++) {
                        for (let x = 20; x < 28; x++) png.data.set([rand(), rand(), rand(), 255], (size * y + x) << 2);
                    }
                }
                return PNG.sync.write(png);
            };
            const masks = [mask(20, 8, 8, 24)];

            for (let radius = 1; radius <= 5; radius++) {
                const results = [];
                for (let trial = 0; trial < 3; trial++) {
                    const r = await service.getDiff(build(0, trial > 0), build(radius, trial > 0), 0.2, radius, masks);
                    results.push({ diffPixels: r.diffPixels, diffPct: r.diffPct, shiftTolerantPixels: r.shiftTolerantPixels });
                }
                assert.deepEqual(results[1], results[0], `radius ${radius}`);
                assert.deepEqual(results[2], results[0], `radius ${radius}`);

                // ...and the two sides may differ under the mask without changing the result
                const left = await service.getDiff(build(0, true), build(radius, false), 0.2, radius, masks);
                assert.equal(left.diffPixels, results[0].diffPixels, `radius ${radius}`);
                assert.equal(left.diffPct, results[0].diffPct, `radius ${radius}`);
            }
        });
    });
});

describe('PixelMatchService masks beside anti-aliasing (real pixelmatch)', () => {
    // The suite above swaps pixelmatch for a mock, which has no anti-aliasing test. Load a second, unpatched copy of the service.
    const servicePath = require.resolve('../../src/services/PixelMatch.service');
    const saved = require.cache[servicePath];
    delete require.cache[servicePath];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RealPixelMatchService = require('../../src/services/PixelMatch.service').PixelMatchService;
    if (saved) require.cache[servicePath] = saved;

    const W = 12;
    const H = 12;
    const maskRect = (x: number, y: number, width: number, height: number) => ({
        id: '00000000-0000-4000-8000-000000000001',
        x,
        y,
        width,
        height,
        label: null
    });

    function toPng(data: Buffer): Buffer {
        const png = new PNG({ width: W, height: H });
        data.copy(png.data);
        return PNG.sync.write(png);
    }

    function randomBase(seed: number): Buffer {
        const base = Buffer.alloc(W * H * 4);
        const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % 200) + 30;
        for (let i = 0; i < W * H; i++) base.set([rnd(), rnd(), rnd(), 255], i * 4);
        return base;
    }

    const put = (data: Buffer, x: number, y: number, c: [number, number, number]) => data.set([...c, 255], (y * W + x) * 4);

    function withChange(base: Buffer, x: number, y: number) {
        const a = Buffer.from(base);
        const b = Buffer.from(base);
        put(a, x, y, [100, 100, 100]);
        put(b, x, y, [200, 40, 40]);
        return { a: toPng(a), b: toPng(b) };
    }

    it('should not let the mask fill excuse a real change in the pixel beside it', async () => {
        const service = new RealPixelMatchService(createMockLogger());
        // P=(5,6) has a darker neighbour (x=4 column) and a brighter one, and the mask starts at x=6
        const base = randomBase(7);
        for (let y = 0; y < H; y++) put(base, 4, y, [0, 0, 0]);
        put(base, 5, 5, [90, 90, 90]);
        put(base, 5, 7, [90, 90, 90]);
        const { a, b } = withChange(base, 5, 6);

        const unmasked = await service.getDiff(a, b, 0.2, 0);
        assert.equal(unmasked.diffPixels, 1);
        const masked = await service.getDiff(a, b, 0.2, 0, [maskRect(6, 0, 6, 12)]);
        assert.equal(masked.diffPixels, 1);
        assert.equal(masked.maskedPixels, 72);
        // the shift pass sees it as any other changed pixel
        assert.equal((await service.getDiff(a, b, 0.2, 1, [maskRect(6, 0, 6, 12)])).diffPixels, 1);
    });

    it('should not let the mask fill excuse a change two pixels away through an unmasked fill-coloured pixel', async () => {
        const service = new RealPixelMatchService(createMockLogger());
        // P=(4,6); Q=(5,6) equals the mask fill and gains siblings from the mask at x>=6
        const base = randomBase(11);
        for (let y = 0; y < H; y++) put(base, 3, y, [0, 0, 0]);
        put(base, 4, 5, [90, 90, 90]);
        put(base, 4, 7, [90, 90, 90]);
        put(base, 5, 5, [110, 110, 110]);
        put(base, 5, 7, [110, 110, 110]);
        put(base, 5, 6, [128, 128, 128]);
        const { a, b } = withChange(base, 4, 6);

        const unmasked = await service.getDiff(a, b, 0.2, 0);
        assert.equal(unmasked.diffPixels, 1);
        for (const shift of [0, 1]) {
            const masked = await service.getDiff(a, b, 0.2, shift, [maskRect(6, 0, 6, 12)]);
            assert.equal(masked.diffPixels, 1, `shift ${shift}`);
        }
    });

    it('should report the same result whatever is under the mask', async () => {
        const service = new RealPixelMatchService(createMockLogger());
        const base = randomBase(7);
        for (let y = 0; y < H; y++) put(base, 4, y, [0, 0, 0]);
        const { a, b } = withChange(base, 5, 6);
        const other = Buffer.from(PNG.sync.read(a).data);
        for (let y = 0; y < H; y++) for (let x = 6; x < W; x++) put(other, x, y, [128, 128, 128]);
        const otherPng = toPng(other);

        const m = [maskRect(6, 0, 6, 12)];
        const r1 = await service.getDiff(a, b, 0.2, 0, m);
        const r2 = await service.getDiff(otherPng, b, 0.2, 0, m);
        assert.equal(r2.diffPixels, r1.diffPixels);
    });

    it('should not excuse beside a mask a pixel that pixelmatch with the fill counts', async () => {
        const service = new RealPixelMatchService(createMockLogger());
        const N = 11;
        const mk = () => {
            const d = Buffer.alloc(N * N * 4);
            for (let y = 0; y < N; y++) {
                for (let x = 0; x < N; x++) {
                    const v = x <= 4 && y >= 5 ? 0 : x >= 6 && y <= 5 ? 255 : 128;
                    d.set([v, v, v, 255], (y * N + x) * 4);
                }
            }
            return d;
        };
        const toP = (d: Buffer) => {
            const png = new PNG({ width: N, height: N });
            d.copy(png.data);
            return PNG.sync.write(png);
        };
        const a = mk();
        const b = mk();
        b.set([0, 0, 0, 255], (5 * N + 5) * 4);
        const r = await service.getDiff(toP(a), toP(b), 0.2, 0, [maskRect(4, 4, 2, 1)]);
        assert.equal(r.diffPixels, 1);
    });

    // Real pixelmatch excuses the changed pixel P=(5,6): darker neighbours at x<=4 and brighter at x>=6, each with 3+ equal
    // siblings in both images, and P changes between two mid-grays.
    function aaScene() {
        const base = Buffer.alloc(W * H * 4);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const v = x <= 4 ? 0 : x >= 6 ? 255 : 128;
                put(base, x, y, [v, v, v]);
            }
        }
        const a = Buffer.from(base);
        const b = Buffer.from(base);
        put(a, 5, 6, [100, 100, 100]);
        put(b, 5, 6, [150, 150, 150]);
        return { a: toPng(a), b: toPng(b) };
    }

    it('should still excuse genuine anti-aliasing: no mask, a distant mask, and a near mask that leaves it anti-aliasing', async () => {
        const service = new RealPixelMatchService(createMockLogger());
        const { a, b } = aaScene();
        assert.equal((await service.getDiff(a, b, 0.2, 0)).diffPixels, 0, 'no mask');
        assert.equal((await service.getDiff(a, b, 0.2, 0, [maskRect(9, 9, 3, 3)])).diffPixels, 0, 'mask more than 2px away');
        // x=7 is 2px from P; with that column absent the dark side and the bright x=6 column still excuse it
        assert.equal((await service.getDiff(a, b, 0.2, 0, [maskRect(7, 0, 1, 12)])).diffPixels, 0, 'mask within 2px, still anti-aliasing');
    });

    it('should agree with real pixelmatch on which pixels are anti-aliasing (drift guard for the port)', async () => {
        const pixelmatch = (await import('pixelmatch')).default;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { isAntialiasedIgnoringMask } = require('../../src/services/MaskedAntialias');
        const S = 16;
        let seed = 20240607;
        const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
        const noMask = new Uint8Array(S * S);
        let yellow = 0;
        let red = 0;
        for (let n = 0; n < 50; n++) {
            const a = new Uint8Array(new ArrayBuffer(S * S * 4));
            const b = new Uint8Array(new ArrayBuffer(S * S * 4));
            const gx = rnd() * 60;
            const gy = rnd() * 60;
            const cut = 4 + Math.floor(rnd() * 8);
            for (let y = 0; y < S; y++) {
                for (let x = 0; x < S; x++) {
                    // flat areas either side of a hard edge, a shallow gradient across them, and a little noise, so anti-aliasing occurs
                    const base = (x < cut ? 40 : 210) + gx * (x / S) + gy * (y / S);
                    const va = Math.max(0, Math.min(255, Math.round(base + Math.floor(rnd() * 3) * 2)));
                    // b differs from a on about one pixel in six, by enough to exceed the colour threshold
                    const vb = rnd() < 0.17 ? Math.max(0, Math.min(255, va + Math.round((rnd() - 0.5) * 160))) : va;
                    a.set([va, va, va, 255], (y * S + x) * 4);
                    b.set([vb, vb, vb, 255], (y * S + x) * 4);
                }
            }
            const out = new Uint8Array(S * S * 4);
            pixelmatch(a, b, out, S, S, { threshold: 0.2, includeAA: false });
            const a32 = new Uint32Array(a.buffer, 0, S * S);
            const b32 = new Uint32Array(b.buffer, 0, S * S);
            for (let i = 0; i < S * S; i++) {
                const o = i * 4;
                const isYellow = out[o] === 255 && out[o + 1] === 255 && out[o + 2] === 0;
                const isRed = out[o] === 255 && out[o + 1] === 0 && out[o + 2] === 0;
                if (!isYellow && !isRed) continue;
                if (isYellow) yellow++;
                else red++;
                const port = isAntialiasedIgnoringMask(a, b, a32, b32, i % S, Math.floor(i / S), S, S, noMask);
                assert.equal(port, isYellow, `image ${n} pixel ${i}`);
            }
        }
        assert.ok(yellow > 20, `anti-aliased pixels exercised: ${yellow}`);
        assert.ok(red > 20, `counted pixels exercised: ${red}`);
    });
});
