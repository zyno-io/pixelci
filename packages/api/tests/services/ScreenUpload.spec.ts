import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crc32 } from 'node:zlib';

import {
    MAX_CHUNKS,
    parseScreenName,
    readPngHeader as readPngHeaderSync,
    repairLatin1Filename,
    validateScreenName
} from '../../src/services/ScreenUpload';

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

function chunk(type: string, data: Buffer) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([len, typeAndData, crc]);
}
const iend = () => chunk('IEND', Buffer.alloc(0));
const secondIhdr = (w: number, h: number) => pngHeader({ width: w, height: h }).subarray(8);

// the validator is synchronous; wrap it so `assert.rejects` can be used uniformly
const readPngHeader = async (buf: Buffer, maxPixels: number) => readPngHeaderSync(buf, maxPixels);
const file = (buf: Buffer) => buf;

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

describe('validateScreenName', () => {
    it('keeps the exact name, including a .png the CLI left after stripping one', () => {
        assert.equal(validateScreenName('logo.png'), 'logo.png');
        assert.equal(validateScreenName('icon.PNG'), 'icon.PNG');
        assert.equal(validateScreenName('say "hi"'), 'say "hi"');
    });

    it('applies the same rules as parseScreenName', () => {
        assert.throws(() => validateScreenName(''));
        assert.throws(() => validateScreenName('a'.repeat(201)));
        assert.throws(() => validateScreenName('a\nb'));
    });
});

describe('readPngHeader', () => {
    it('returns dimensions for a valid header', async () => {
        assert.deepEqual(await readPngHeader(file(Buffer.concat([pngHeader(), iend()])), 25_000_000), { width: 100, height: 50 });
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

    it('accepts a complete chunk sequence ending in IEND', async () => {
        const buf = Buffer.concat([pngHeader(), chunk('IDAT', Buffer.alloc(100)), iend()]);
        assert.deepEqual(await readPngHeader(file(buf), 1e9), { width: 100, height: 50 });
    });

    it('rejects a second IHDR (which would override the checked dimensions)', async () => {
        const buf = Buffer.concat([pngHeader(), secondIhdr(6000, 6000), chunk('IDAT', Buffer.alloc(10)), iend()]);
        await assert.rejects(readPngHeader(file(buf), 25_000_000), { httpCode: 400 });
        // also after other chunks
        const late = Buffer.concat([pngHeader(), chunk('IDAT', Buffer.alloc(10)), secondIhdr(6000, 6000), iend()]);
        await assert.rejects(readPngHeader(file(late), 25_000_000), { httpCode: 400 });
    });

    it('rejects a truncated chunk', async () => {
        const buf = Buffer.concat([pngHeader(), chunk('IDAT', Buffer.alloc(100)), iend()]);
        await assert.rejects(readPngHeader(file(buf.subarray(0, buf.length - 20)), 1e9), { httpCode: 400 });
        // IDAT whose declared length runs past EOF
        const lying = Buffer.concat([pngHeader(), chunk('IDAT', Buffer.alloc(100)).subarray(0, 50)]);
        await assert.rejects(readPngHeader(file(lying), 1e9), { httpCode: 400 });
    });

    it('rejects a file with no IEND', async () => {
        await assert.rejects(readPngHeader(file(Buffer.concat([pngHeader(), chunk('IDAT', Buffer.alloc(10))])), 1e9), { httpCode: 400 });
    });

    it('rejects a chunk length above 2^31-1 via the length check (not the EOF check)', async () => {
        const huge = Buffer.alloc(12);
        huge.writeUInt32BE(0x80000000, 0);
        huge.write('IDAT', 4, 'latin1');
        await assert.rejects(readPngHeader(file(Buffer.concat([pngHeader(), huge])), 1e9), { httpCode: 400, message: /chunk length/ });
        // a length within range that runs past EOF is reported as truncation instead
        const lying = Buffer.from(huge);
        lying.writeUInt32BE(1000, 0);
        await assert.rejects(readPngHeader(file(Buffer.concat([pngHeader(), lying])), 1e9), { httpCode: 400, message: /truncated/ });
    });

    it('enforces MAX_CHUNKS', async () => {
        const empty = chunk('tEXt', Buffer.alloc(0));
        const ok = Buffer.concat([pngHeader(), ...Array.from({ length: MAX_CHUNKS - 1 }, () => empty), iend()]);
        assert.deepEqual(await readPngHeader(ok, 1e9), { width: 100, height: 50 });
        const tooMany = Buffer.concat([pngHeader(), ...Array.from({ length: MAX_CHUNKS }, () => empty), iend()]);
        await assert.rejects(readPngHeader(tooMany, 1e9), { httpCode: 400, message: /too many/ });
    });

    it('enforces the pixel cap', async () => {
        assert.deepEqual(await readPngHeader(file(Buffer.concat([pngHeader({ width: 5000, height: 5000 }), iend()])), 25_000_000), {
            width: 5000,
            height: 5000
        });
        await assert.rejects(readPngHeader(file(pngHeader({ width: 5001, height: 5000 })), 25_000_000), { httpCode: 400 });
        await assert.rejects(readPngHeader(file(pngHeader({ width: 0xffffffff, height: 0xffffffff })), 25_000_000), { httpCode: 400 });
    });
});

describe('repairLatin1Filename', () => {
    it('repairs a UTF-8 name that was decoded as latin1', () => {
        const mangled = Buffer.from('café 日本.png', 'utf8').toString('latin1');
        assert.equal(repairLatin1Filename(mangled), 'café 日本.png');
    });

    it('leaves ASCII and genuine latin1 names alone', () => {
        assert.equal(repairLatin1Filename('plain.png'), 'plain.png');
        assert.equal(repairLatin1Filename('café.png'), 'café.png');
        assert.equal(repairLatin1Filename(undefined), undefined);
    });
});
