import { decodeThumbnail } from './attachment-jpeg.js';

export const MAX_ATTACHMENTS = 3;
export const MAX_IMAGE_BYTES = 24576;
export const MAX_IMAGE_EDGE = 192;
export const MAX_BODY_BYTES = 262144;
export const ATTACHMENT_ID = /^[0-9a-f]{32}$/;

export function attachmentError(code, status = 400) {
    return Object.assign(new Error(code), { status });
}

export async function readRecordInput(request) {
    const declared = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        try { await request.body?.cancel(); } catch { /* The size error remains authoritative. */ }
        throw attachmentError('BODY_TOO_LARGE', 413);
    }
    const reader = request.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_BODY_BYTES) {
                    try { await reader.cancel(); } catch { /* Do not replace the 413 with a cancellation error. */ }
                    throw attachmentError('BODY_TOO_LARGE', 413);
                }
                chunks.push(value);
            }
        } finally { reader.releaseLock(); }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try {
        const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
        return input;
    } catch { throw attachmentError('INVALID_JSON'); }
}

export function attachmentManifest(row, id, admin = false) {
    let items;
    try { items = JSON.parse(row.attachments_json || '[]'); } catch { return []; }
    if (!Array.isArray(items)) return [];
    const root = admin ? '/admin/api/students/' : '/api/leave/';
    const result = [], seen = new Set();
    for (const item of items) {
        if (!item || typeof item.id !== 'string' || !ATTACHMENT_ID.test(item.id) || seen.has(item.id) ||
            !Number.isInteger(item.width) || !Number.isInteger(item.height) ||
            item.width < 1 || item.width > MAX_IMAGE_EDGE || item.height < 1 || item.height > MAX_IMAGE_EDGE) continue;
        seen.add(item.id);
        result.push({ id: item.id, width: item.width, height: item.height,
            url: root + id + '/attachments/' + item.id });
        if (result.length === MAX_ATTACHMENTS) break;
    }
    return result;
}

export function attachmentWriteError(error) {
    const message = String(error.message);
    if (message.includes('attachment_storage_quota')) return { error: 'ATTACHMENT_QUOTA_EXCEEDED', status: 409 };
    if (message.includes('attachment_manifest_conflict')) return { error: 'ATTACHMENT_CONFLICT', status: 409 };
    return { error: error.message, status: error.status || 400 };
}

export function prepareAttachments(input, existing = null) {
    const original = existing?.attachments_json || '[]';
    let previous;
    try { previous = JSON.parse(original); } catch { throw attachmentError('INVALID_ATTACHMENTS'); }
    if (!Array.isArray(previous) || previous.length > MAX_ATTACHMENTS ||
        attachmentManifest({ attachments_json: original }, '').length !== previous.length) {
        throw attachmentError('INVALID_ATTACHMENTS');
    }
    if (!Object.hasOwn(input, 'attachments')) return { json: original, added: [], removed: [] };
    if (!Array.isArray(input.attachments)) throw attachmentError('INVALID_ATTACHMENTS');
    if (input.attachments.length > MAX_ATTACHMENTS) throw attachmentError('ATTACHMENT_LIMIT_EXCEEDED');
    const known = new Map(previous.map(item => [item.id, item]));
    const kept = new Set(), added = [], manifest = [];
    for (const item of input.attachments) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw attachmentError('INVALID_ATTACHMENTS');
        if (Object.hasOwn(item, 'id')) {
            if (Object.hasOwn(item, 'data') || !ATTACHMENT_ID.test(item.id) ||
                !known.has(item.id) || kept.has(item.id)) throw attachmentError('INVALID_ATTACHMENT_REFERENCE');
            kept.add(item.id);
            manifest.push(known.get(item.id));
        } else {
            const image = decodeThumbnail(item.data);
            const id = Array.from(crypto.getRandomValues(new Uint8Array(16)),
                byte => byte.toString(16).padStart(2, '0')).join('');
            added.push({ id, ...image });
            manifest.push({ id, width: image.width, height: image.height });
        }
    }
    return { json: JSON.stringify(manifest), added,
        removed: previous.filter(item => !kept.has(item.id)).map(item => item.id) };
}

export function attachmentStatements(db, tokenHash, plan, existing = null) {
    const statements = [];
    if (existing) {
        // A failed CHECK aborts the whole batch before a stale manifest can be saved.
        statements.push(db.prepare(`UPDATE leave_attachment_usage SET manifest_guard = CASE
            WHEN EXISTS (SELECT 1 FROM leave_share_records WHERE token_hash = ?1
                AND attachments_json = ?2) THEN 1 ELSE 0 END WHERE singleton = 1`)
            .bind(tokenHash, existing.attachments_json || '[]'));
    }
    for (const id of plan.removed) statements.push(db.prepare(
        'DELETE FROM leave_record_attachments WHERE token_hash = ?1 AND attachment_id = ?2'
    ).bind(tokenHash, id));
    for (const image of plan.added) statements.push(db.prepare(`INSERT INTO leave_record_attachments
        (token_hash, attachment_id, width, height, byte_size, thumbnail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
        .bind(tokenHash, image.id, image.width, image.height, image.bytes.byteLength, image.bytes));
    return statements;
}
