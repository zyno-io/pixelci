import { HttpBadRequestError } from '@zyno-io/ts-server-foundation';
import { crc32 } from 'zlib';

export const MAX_SCREEN_NAME_LENGTH = 200;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_CHUNK_LENGTH = 2 ** 31 - 1;
export const MAX_CHUNKS = 100_000; // bounds the walk below; real PNGs have a few thousand chunks at most
const PNG_HEADER_LENGTH = 33; // signature (8) + IHDR chunk: length (4) + type (4) + data (13) + CRC (4)

// Control characters, line/paragraph separators, and bidi override/isolate controls
// (built from a string: the type compiler would emit a regex literal containing raw U+2028/2029, which is a syntax error)
const FORBIDDEN_NAME_CHARS = new RegExp('[\\p{Cc}\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069]', 'u');

/** Derives the screen name from the uploaded file name. Strips only a trailing ".png"; no trimming or normalization. */
export function parseScreenName(originalName: string | undefined): string {
    const name = (originalName ?? '').replace(/\.png$/i, '');
    if (!name) throw new HttpBadRequestError('Screen name must not be empty');
    if ([...name].length > MAX_SCREEN_NAME_LENGTH) {
        throw new HttpBadRequestError(`Screen name must be at most ${MAX_SCREEN_NAME_LENGTH} characters`);
    }
    if (FORBIDDEN_NAME_CHARS.test(name)) throw new HttpBadRequestError('Screen name contains forbidden characters');
    return name;
}

/** Re-decodes a filename that a multipart parser decoded as latin1 when its bytes were really UTF-8; otherwise returns it unchanged. */
export function repairLatin1Filename(fileName: string | undefined): string | undefined {
    if (!fileName) return fileName;
    const decoded = Buffer.from(fileName, 'latin1').toString('utf8');
    return !decoded.includes('\uFFFD') && decoded !== fileName ? decoded : fileName;
}

/** Validates the PNG signature and chunk structure of an in-memory file (without decoding it) and returns the dimensions. */
export function readPngHeader(buf: Buffer, maxPixels: number): { width: number; height: number } {
    if (buf.length < PNG_HEADER_LENGTH || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new HttpBadRequestError('Image is not a valid PNG');
    }
    if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') {
        throw new HttpBadRequestError('Image has an invalid PNG header');
    }
    if (crc32(buf.subarray(12, 29)) !== buf.readUInt32BE(29)) {
        throw new HttpBadRequestError('Image has a corrupt PNG header');
    }

    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width < 1 || height < 1) throw new HttpBadRequestError('Image has invalid dimensions');
    if (buf[26] !== 0 || buf[27] !== 0) throw new HttpBadRequestError('Image has an invalid PNG header');
    if (width * height > maxPixels) {
        throw new HttpBadRequestError(`Image is too large (${width}x${height}); the maximum is ${maxPixels} pixels`);
    }

    // The decoder lets a later IHDR override the dimensions, so walk the chunk headers and reject any other IHDR.
    let pos = PNG_HEADER_LENGTH;
    for (let i = 0; ; i++) {
        if (i >= MAX_CHUNKS) throw new HttpBadRequestError('Image has too many PNG chunks');
        if (pos + 8 > buf.length) throw new HttpBadRequestError('Image is truncated');
        const length = buf.readUInt32BE(pos);
        const type = buf.toString('latin1', pos + 4, pos + 8);
        if (type === 'IHDR') throw new HttpBadRequestError('Image has more than one PNG header');
        if (length > MAX_CHUNK_LENGTH) throw new HttpBadRequestError('Image has an invalid PNG chunk length');
        if (pos + 8 + length + 4 > buf.length) throw new HttpBadRequestError('Image is truncated');
        if (type === 'IEND') break;
        pos += 8 + length + 4;
    }
    return { width, height };
}
