export const MAX_ATTACHMENTS = 3;
export const THUMBNAIL_EDGE = 192;
export const MAX_THUMBNAIL_BYTES = 24576;
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 50000000;
const MAX_SOURCE_EDGE = 16000;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const fail = code => { throw new Error(code); };

export function validateSourceFile(file) {
    if (!file || !Number.isSafeInteger(file.size) || file.size < 1) fail('ATTACHMENT_EMPTY');
    if (file.size > MAX_SOURCE_BYTES) fail('ATTACHMENT_SOURCE_TOO_LARGE');
    if (file.type && !TYPES.has(file.type.toLowerCase())) fail('ATTACHMENT_TYPE');
}

function exifOrientation(bytes, start, end) {
    if (start + 8 > end) return 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
    if (!little && !(bytes[start] === 0x4d && bytes[start + 1] === 0x4d)) return 1;
    const word = offset => view.getUint16(offset, little);
    if (word(start + 2) !== 42) return 1;
    const table = start + view.getUint32(start + 4, little);
    if (table < start || table + 2 > end) return 1;
    const count = word(table);
    for (let index = 0; index < count; index++) {
        const entry = table + 2 + index * 12;
        if (entry + 12 > end) return 1;
        if (word(entry) === 0x112 && word(entry + 2) === 3 && view.getUint32(entry + 4, little) === 1) {
            const value = word(entry + 8);
            return value >= 1 && value <= 8 ? value : 1;
        }
    }
    return 1;
}

export function inspectImage(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let width, height, orientation = 1, parts = 0;
    if (bytes.length >= 24 && bytes[0] === 137 && String.fromCharCode(...bytes.subarray(1, 8)) === 'PNG\r\n\x1a\n') {
        width = view.getUint32(16); height = view.getUint32(20);
    } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset + 4 <= bytes.length) {
            if (++parts > 1024) fail('ATTACHMENT_DECODE');
            if (bytes[offset++] !== 0xff) fail('ATTACHMENT_DECODE');
            while (bytes[offset] === 0xff) offset++;
            const marker = bytes[offset++];
            if (marker === 0xda || marker === 0xd9) break;
            if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
            if (offset + 2 > bytes.length) fail('ATTACHMENT_DECODE');
            const length = view.getUint16(offset);
            if (length < 2 || offset + length > bytes.length) fail('ATTACHMENT_DECODE');
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                if (length < 8) fail('ATTACHMENT_DECODE');
                height = view.getUint16(offset + 3); width = view.getUint16(offset + 5);
            }
            if (marker === 0xe1 && length >= 16 &&
                String.fromCharCode(...bytes.subarray(offset + 2, offset + 8)) === 'Exif\0\0') {
                orientation = exifOrientation(bytes, offset + 8, offset + length);
            }
            offset += length;
        }
    } else if (bytes.length >= 20 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
        String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') {
        for (let offset = 12; offset + 8 <= bytes.length;) {
            if (++parts > 1024) fail('ATTACHMENT_DECODE');
            const tag = String.fromCharCode(...bytes.subarray(offset, offset + 4));
            const size = view.getUint32(offset + 4, true), data = offset + 8;
            if (data + size > bytes.length) fail('ATTACHMENT_DECODE');
            if (tag === 'VP8X' && size >= 10) {
                width = 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16);
                height = 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16);
            } else if (tag === 'VP8L' && size >= 5 && bytes[data] === 0x2f && !width) {
                const bits = view.getUint32(data + 1, true);
                width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff);
            } else if (tag === 'VP8 ' && size >= 10 && !width && bytes[data + 3] === 0x9d && bytes[data + 4] === 1 && bytes[data + 5] === 0x2a) {
                width = view.getUint16(data + 6, true) & 0x3fff;
                height = view.getUint16(data + 8, true) & 0x3fff;
            } else if (tag === 'EXIF') {
                const prefix = String.fromCharCode(...bytes.subarray(data, data + 6));
                orientation = exifOrientation(bytes, prefix === 'Exif\0\0' ? data + 6 : data, data + size);
            }
            offset = data + size + (size & 1);
        }
    } else fail('ATTACHMENT_TYPE');
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) fail('ATTACHMENT_DECODE');
    if (width > MAX_SOURCE_EDGE || height > MAX_SOURCE_EDGE || width * height > MAX_SOURCE_PIXELS) fail('ATTACHMENT_DIMENSIONS');
    return orientation >= 5 ? { width: height, height: width } : { width, height };
}

const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
function readDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('ATTACHMENT_ENCODE'));
        reader.readAsDataURL(blob);
    });
}

async function decodeSource(file, width, height) {
    if (typeof createImageBitmap === 'function') {
        try {
            const image = await createImageBitmap(file, { imageOrientation: 'from-image',
                resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
            return { image, width: image.width, height: image.height, release: () => image.close() };
        } catch { /* Older decoders can still use the browser's image element. */ }
    }
    const url = URL.createObjectURL(file), image = new Image();
    image.decoding = 'async';
    try {
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('ATTACHMENT_DECODE'));
            image.src = url;
        });
        if (typeof image.decode === 'function') await image.decode();
        return { image, width: image.naturalWidth, height: image.naturalHeight,
            release: () => { image.onload = image.onerror = null; image.removeAttribute('src'); URL.revokeObjectURL(url); } };
    } catch (error) { URL.revokeObjectURL(url); throw error; }
}

export async function createAttachmentThumbnail(file) {
    validateSourceFile(file);
    await yieldTask();
    const source = inspectImage(new Uint8Array(await file.arrayBuffer()));
    const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(source.width, source.height));
    const decoded = await decodeSource(file, Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)));
    try {
        await yieldTask();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = THUMBNAIL_EDGE;
        const context = canvas.getContext('2d');
        if (!context) fail('ATTACHMENT_ENCODE');
        context.fillStyle = '#fff'; context.fillRect(0, 0, THUMBNAIL_EDGE, THUMBNAIL_EDGE);
        const ratio = Math.min(1, THUMBNAIL_EDGE / Math.max(decoded.width, decoded.height));
        const width = decoded.width * ratio, height = decoded.height * ratio;
        context.drawImage(decoded.image, (THUMBNAIL_EDGE - width) / 2, (THUMBNAIL_EDGE - height) / 2, width, height);
        for (const quality of [0.84, 0.64, 0.44]) {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
            if (!blob || blob.type !== 'image/jpeg') fail('ATTACHMENT_ENCODE');
            if (blob.size <= MAX_THUMBNAIL_BYTES) return { data: await readDataUrl(blob),
                width: THUMBNAIL_EDGE, height: THUMBNAIL_EDGE, bytes: blob.size };
            await yieldTask();
        }
        fail('ATTACHMENT_TOO_LARGE');
    } finally { decoded.release(); }
}
