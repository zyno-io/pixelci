import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs/browser';

import { S3Service } from '../../src/services/S3.service';
import { makeThumbnail, THUMBNAIL_MAX_ASPECT, THUMBNAIL_MAX_WIDTH, ThumbnailService } from '../../src/services/Thumbnail.service';

function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): Buffer {
    const img = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            img.data.set(paint(x, y), (y * width + x) * 4);
        }
    }
    return PNG.sync.write(img);
}

describe('makeThumbnail', () => {
    it('scales a wide image down to the maximum width, keeping its shape', () => {
        const out = PNG.sync.read(makeThumbnail(png(1920, 1080, () => [10, 20, 30, 255])));
        assert.equal(out.width, THUMBNAIL_MAX_WIDTH);
        assert.equal(out.height, 360);
        assert.deepEqual([...out.data.subarray(0, 4)], [10, 20, 30, 255]);
        assert.deepEqual([...out.data.subarray(out.data.length - 4)], [10, 20, 30, 255]);
    });

    it('does not scale a small image up', () => {
        const out = PNG.sync.read(makeThumbnail(png(200, 100, (x, y) => [x, y, 0, 255])));
        assert.equal(out.width, 200);
        assert.equal(out.height, 100);
        assert.deepEqual([...out.data.subarray((50 * 200 + 120) * 4, (50 * 200 + 120) * 4 + 4)], [120, 50, 0, 255]);
    });

    it('averages the source pixels each output pixel covers', () => {
        // 1px black/white columns halve to a uniform mid grey; sampling would give all black or all white
        const out = PNG.sync.read(makeThumbnail(png(1280, 4, x => (x % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]))));
        assert.equal(out.width, 640);
        assert.equal(out.height, 2);
        for (let i = 0; i < out.data.length; i += 4) {
            assert.ok(Math.abs(out.data[i] - 128) <= 1, `pixel ${i / 4} is ${out.data[i]}`);
            assert.equal(out.data[i + 3], 255);
        }
    });

    it('handles a scale that is not a whole number', () => {
        // 960 -> 640 is 1.5 source pixels per output pixel; a flat colour must stay exactly flat
        const out = PNG.sync.read(makeThumbnail(png(960, 300, () => [200, 100, 50, 255])));
        assert.equal(out.width, 640);
        assert.equal(out.height, 200);
        for (let i = 0; i < out.data.length; i += 4) {
            assert.deepEqual([...out.data.subarray(i, i + 4)], [200, 100, 50, 255]);
        }
    });

    it('keeps the top of a very long page and crops the rest', () => {
        // top half red, bottom half blue; only the top fits in the cropped thumbnail
        const out = PNG.sync.read(makeThumbnail(png(1280, 8000, (_x, y) => (y < 4000 ? [255, 0, 0, 255] : [0, 0, 255, 255]))));
        assert.equal(out.width, 640);
        assert.equal(out.height, 640 * THUMBNAIL_MAX_ASPECT);
        assert.deepEqual([...out.data.subarray(out.data.length - 4)], [255, 0, 0, 255]);
    });

    it('does not let transparent pixels tint their neighbours', () => {
        // transparent green beside opaque red: the blend is half-transparent red, with no green in it
        const out = PNG.sync.read(makeThumbnail(png(1280, 2, x => (x % 2 ? [0, 255, 0, 0] : [255, 0, 0, 255]))));
        assert.deepEqual([...out.data.subarray(0, 4)], [255, 0, 0, 128]);
    });
});

describe('ThumbnailService', () => {
    function fakeS3(objects: Map<string, Buffer>) {
        const calls = { exists: 0, get: 0, upload: 0 };
        const s3 = {
            getPathForScreen: (a: string, b: string, s: string) => `screens/${a}/${b}/${s}.png`,
            getPathForThumbnail: (a: string, b: string, s: string, u: string) => `screens/${a}/${b}/${s}.${u}.thumb.png`,
            exists: async (path: string) => {
                calls.exists++;
                return objects.has(path);
            },
            getBuffer: async (path: string) => {
                calls.get++;
                const buf = objects.get(path);
                if (!buf) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
                return buf;
            },
            uploadFile: async (buf: Buffer, path: string) => {
                calls.upload++;
                objects.set(path, buf);
            }
        };
        return { s3: s3 as unknown as S3Service, calls };
    }

    it('generates a thumbnail once and reuses it', async () => {
        const objects = new Map([['screens/a/b/s.png', png(1280, 720, () => [1, 2, 3, 255])]]);
        const { s3, calls } = fakeS3(objects);
        const svc = new ThumbnailService(s3);

        const paths = await Promise.all([svc.ensure('a', 'b', 's', 'u'), svc.ensure('a', 'b', 's', 'u')]);
        assert.deepEqual(paths, ['screens/a/b/s.u.thumb.png', 'screens/a/b/s.u.thumb.png']);
        await svc.ensure('a', 'b', 's', 'u');

        assert.deepEqual(calls, { exists: 1, get: 1, upload: 1 });
        assert.equal(PNG.sync.read(objects.get('screens/a/b/s.u.thumb.png')!).width, 640);
    });

    it('uses a thumbnail already in storage without regenerating it', async () => {
        const objects = new Map([['screens/a/b/s.u.thumb.png', Buffer.from('existing')]]);
        const { s3, calls } = fakeS3(objects);
        assert.equal(await new ThumbnailService(s3).ensure('a', 'b', 's', 'u'), 'screens/a/b/s.u.thumb.png');
        assert.deepEqual(calls, { exists: 1, get: 0, upload: 0 });
    });

    it('makes a new thumbnail when the screenshot is uploaded again', async () => {
        const objects = new Map([['screens/a/b/s.png', png(1280, 720, () => [1, 2, 3, 255])]]);
        const { s3, calls } = fakeS3(objects);
        const svc = new ThumbnailService(s3);
        await svc.ensure('a', 'b', 's', 'u');
        objects.set(
            'screens/a/b/s.png',
            png(1280, 720, () => [9, 9, 9, 255])
        );
        const path = await svc.ensure('a', 'b', 's', 'u2');
        assert.equal(calls.upload, 2);
        assert.deepEqual([...PNG.sync.read(objects.get(path)!).data.subarray(0, 4)], [9, 9, 9, 255]);
    });

    it('fails when the screenshot is missing, and tries again next time', async () => {
        const objects = new Map<string, Buffer>();
        const { s3, calls } = fakeS3(objects);
        const svc = new ThumbnailService(s3);
        await assert.rejects(svc.ensure('a', 'b', 's', 'u'), { name: 'NoSuchKey' });
        objects.set(
            'screens/a/b/s.png',
            png(10, 10, () => [0, 0, 0, 255])
        );
        assert.equal(await svc.ensure('a', 'b', 's', 'u'), 'screens/a/b/s.u.thumb.png');
        assert.equal(calls.upload, 1);
    });
});
