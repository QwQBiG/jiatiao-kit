import { attachmentError, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE } from './leave-attachments.js';

// Parse markers and bounded entropy bytes; no image decompression is performed.
export function validateJpeg(bytes) {
    const invalid = () => { throw attachmentError('INVALID_ATTACHMENT_JPEG'); };
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw attachmentError('ATTACHMENT_TOO_LARGE');
    if (bytes[0] !== 255 || bytes[1] !== 216) invalid();
    const parts = [bytes.subarray(0, 2)];
    let offset = 2, width = 0, height = 0, components = 0, scans = 0;
    let quantization = false, huffman = false;
    const word = at => bytes[at] * 256 + bytes[at + 1];
    while (offset < bytes.length) {
        const start = offset;
        if (bytes[offset++] !== 255) invalid();
        while (bytes[offset] === 255) offset++;
        const marker = bytes[offset++];
        if (marker === 217) {
            if (!width || !scans || offset !== bytes.length) invalid();
            parts.push(bytes.subarray(start, offset));
            const clean = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
            let at = 0;
            for (const part of parts) { clean.set(part, at); at += part.length; }
            return { bytes: clean, width, height };
        }
        if (marker === undefined || marker === 0 || marker === 216 || marker === 1 ||
            (marker >= 208 && marker <= 215) || offset + 2 > bytes.length) invalid();
        const length = word(offset);
        const end = offset + length;
        if (length < 2 || end > bytes.length) invalid();
        const data = offset + 2;
        if (marker === 219) {
            let at = data;
            while (at < end) {
                const table = bytes[at++];
                if ((table >> 4) > 1 || (table & 15) > 3) invalid();
                at += 64 * ((table >> 4) + 1);
            }
            if (at !== end || at === data) invalid();
            quantization = true;
        }
        if (marker === 196) {
            let at = data;
            while (at < end) {
                const table = bytes[at++];
                if ((table >> 4) > 1 || (table & 15) > 3 || at + 16 > end) invalid();
                let symbols = 0;
                for (let i = 0; i < 16; i++) symbols += bytes[at++];
                if (!symbols || symbols > 256) invalid();
                at += symbols;
            }
            if (at !== end || at === data) invalid();
            huffman = true;
        }
        if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
            if (![192, 194].includes(marker) || width || length < 11 || bytes[data] !== 8) invalid();
            height = word(data + 1); width = word(data + 3); components = bytes[data + 5];
            if (![1, 3].includes(components) || length !== 8 + components * 3) invalid();
            if (!width || !height || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
                throw attachmentError('ATTACHMENT_DIMENSIONS_EXCEEDED');
            }
        }
        if (![225, 237, 254].includes(marker)) parts.push(bytes.subarray(start, end));
        offset = end;
        if (marker === 218) {
            const count = bytes[data];
            if (!width || !quantization || !huffman || count < 1 || count > components || length !== 6 + count * 2) invalid();
            scans++;
            const entropy = offset;
            while (offset < bytes.length) {
                if (bytes[offset] !== 255) { offset++; continue; }
                const next = bytes[offset + 1];
                if (next === 0 || (next >= 208 && next <= 215)) { offset += 2; continue; }
                break;
            }
            if (offset === entropy) invalid();
            parts.push(bytes.subarray(entropy, offset));
        }
    }
    invalid();
}

export function decodeThumbnail(data) {
    if (typeof data !== 'string' || !data.startsWith('data:image/jpeg;base64,')) {
        throw attachmentError('ATTACHMENT_JPEG_ONLY');
    }
    const encoded = data.slice(23);
    if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw attachmentError('ATTACHMENT_TOO_LARGE');
    if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        throw attachmentError('INVALID_ATTACHMENT_JPEG');
    }
    let binary;
    try { binary = atob(encoded); } catch { throw attachmentError('INVALID_ATTACHMENT_JPEG'); }
    return validateJpeg(Uint8Array.from(binary, char => char.charCodeAt(0)));
}
