import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { crc32 } from 'node:zlib';

import { parseScreenName, readPngHeader } from '../../src/services/ScreenUpload';

const dir = mkdtempSync(join(tmpdir(), 'screen-upload-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngHeader(
    opts: { width?: number; height?: number; compression?: number; filter?: number; length?: number; type?: string; badCrc?: boolean } = {}
) {
    const ihdr = Buffer.alloc(17);
    ihdr.write(opts.type ?? 'IHDR', 0, 'latin1');
    ihdr.writeUInt32BE(opts.width ?? 100, 4);
    ihdr.writeUInt32BE(opts.height ?? 50, 8);
    ihdr[12] = 8; // bit depth
    ihdr[13] = 6; // color type
    ihdr[14] = opts.compression ?? 0;
    ihdr[15] = opts.filter ?? 0;
    ihdr[16] = 0; // interlace
    const len = Buffer.alloc(4);
    len.writeUInt32BE(opts.length ?? 13);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((crc32(ihdr) ^ (opts.badCrc ? 1 : 0)) >>> 0);
    return Buffer.concat([SIGNATURE, len, ihdr, crc]);
}

let n = 0;
function file(buf: Buffer) {
    const p = join(dir, `f${n++}.png`);
    writeFileSync(p, buf);
    return p;
}

describe('parseScreenName', () => {
    it('strips only a trailing .png (case-insensitive)', () => {
        assert.equal(parseScreenName('home.png'), 'home');
        assert.equal(parseScreenName('home.PNG'), 'home');
        assert.equal(parseScreenName('home.v2.png'), 'home.v2');
        assert.equal(parseScreenName('home.jpg'), 'home.jpg');
        assert.equal(parseScreenName('a.png.png'), 'a.png');
    });

    it('does not trim or normalize', () => {
        assert.equal(parseScreenName(' home .png'), ' home ');
        assert.equal(parseScreenName('é.png'), 'é');
    });

    it('rejects an empty name', () => {
        assert.throws(() => parseScreenName('.png'), { httpCode: 400 });
        assert.throws(() => parseScreenName(''), { httpCode: 400 });
        assert.throws(() => parseScreenName(undefined), { httpCode: 400 });
    });

    it('enforces the 200 character limit', () => {
        assert.equal(parseScreenName('a'.repeat(200) + '.png'), 'a'.repeat(200));
        assert.throws(() => parseScreenName('a'.repeat(201) + '.png'), { httpCode: 400 });
    });

    it('rejects control characters, line separators and bidi controls', () => {
        for (const ch of ['\u0000', '\n', '\t', '\u007f', '\u0085', ' ', ' ', '‪', '‮', '⁦', '⁩']) {
            assert.throws(() => parseScreenName(`a${ch}b.png`), { httpCode: 400 }, JSON.stringify(ch));
        }
    });

    it('allows ordinary unicode', () => {
        assert.equal(parseScreenName('日本語 screen/💥.png'), '日本語 screen/💥');
    });
});

describe('readPngHeader', () => {
    it('returns dimensions for a valid header', async () => {
        assert.deepEqual(await readPngHeader(file(pngHeader()), 25_000_000), { width: 100, height: 50 });
    });

    it('rejects a bad signature', async () => {
        const buf = pngHeader();
        buf[1] = 0x51;
        await assert.rejects(readPngHeader(file(buf), 1e9), { httpCode: 400 });
    });

    it('rejects a truncated file', async () => {
        await assert.rejects(readPngHeader(file(pngHeader().subarray(0, 20)), 1e9), { httpCode: 400 });
        await assert.rejects(readPngHeader(file(Buffer.alloc(0)), 1e9), { httpCode: 400 });
    });

    it('rejects a wrong IHDR length or type', async () => {
        await assert.rejects(readPngHeader(file(pngHeader({ length: 12 })), 1e9), { httpCode: 400 });
        await assert.rejects(readPngHeader(file(pngHeader({ type: 'IDAT' })), 1e9), { httpCode: 400 });
    });

    it('rejects a bad CRC', async () => {
        await assert.rejects(readPngHeader(file(pngHeader({ badCrc: true })), 1e9), { httpCode: 400 });
    });

    it('rejects zero dimensions', async () => {
        await assert.rejects(readPngHeader(file(pngHeader({ width: 0 })), 1e9), { httpCode: 400 });
        await assert.rejects(readPngHeader(file(pngHeader({ height: 0 })), 1e9), { httpCode: 400 });
    });

    it('rejects non-zero compression or filter method', async () => {
        await assert.rejects(readPngHeader(file(pngHeader({ compression: 1 })), 1e9), { httpCode: 400 });
        await assert.rejects(readPngHeader(file(pngHeader({ filter: 1 })), 1e9), { httpCode: 400 });
    });

    it('enforces the pixel cap', async () => {
        assert.deepEqual(await readPngHeader(file(pngHeader({ width: 5000, height: 5000 })), 25_000_000), { width: 5000, height: 5000 });
        await assert.rejects(readPngHeader(file(pngHeader({ width: 5001, height: 5000 })), 25_000_000), { httpCode: 400 });
        await assert.rejects(readPngHeader(file(pngHeader({ width: 0xffffffff, height: 0xffffffff })), 25_000_000), { httpCode: 400 });
    });
});
