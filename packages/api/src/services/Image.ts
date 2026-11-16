import sharp from 'sharp';

/** Decoded 8-bit RGBA pixels, row-major with no padding (the layout pixelmatch reads). */
export interface IRgbaImage {
    width: number;
    height: number;
    data: Buffer;
}

/**
 * Decodes an image to 8-bit RGBA. Embedded ICC profiles are ignored, so the pixels are the stored
 * values exactly as before (pngjs never applied them): a profile must not make two identical uploads
 * differ, or shift every pixel of a screenshot taken on a wide-gamut display. 16-bit PNGs are reduced
 * to 8 bits; both sides of a comparison always go through here, so the rounding is consistent.
 *
 * `toSrgb` applies the profile instead, for images people look at (thumbnails), not compare.
 */
export async function decodeRgba(source: Uint8Array, options: { toSrgb?: boolean } = {}): Promise<IRgbaImage> {
    const { data, info } = await sharp(asBuffer(source), { ignoreIcc: !options.toSrgb })
        .ensureAlpha()
        .raw({ depth: 'uchar' })
        .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) throw new Error(`Expected 4 channels after decode, got ${info.channels}`);
    return { width: info.width, height: info.height, data };
}

/** sharp only accepts a Node Buffer (not, say, the browser-Buffer polyfill pngjs/browser returns). */
export function asBuffer(source: Uint8Array): Buffer {
    return Buffer.isBuffer(source) ? source : Buffer.from(source.buffer, source.byteOffset, source.byteLength);
}

export function encodePng(image: IRgbaImage): Promise<Buffer> {
    return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
        .png()
        .toBuffer();
}
