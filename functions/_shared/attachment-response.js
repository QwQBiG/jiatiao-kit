import { ATTACHMENT_ID } from './leave-attachments.js';
import { canAccess, hashShareId } from './admin-records.js';

const PRIVATE_HEADERS = {
    'Cache-Control': 'private, no-store, max-age=0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Cross-Origin-Resource-Policy': 'same-origin'
};

export async function attachmentResponse(context, admin = false) {
    const head = context.request.method === 'HEAD';
    const failure = (code, status) => new Response(head ? null : JSON.stringify({ error: code }), {
        status, headers: { ...PRIVATE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' }
    });
    if (!['GET', 'HEAD'].includes(context.request.method)) return failure('METHOD_NOT_ALLOWED', 405);
    const id = String(context.params.id || '').toLowerCase();
    const aid = String(context.params.aid || '').toLowerCase();
    if (!ATTACHMENT_ID.test(id) || !ATTACHMENT_ID.test(aid)) return failure('INVALID_ID', 400);
    if (!context.env.DB) return failure('SERVICE_NOT_CONFIGURED', 503);
    try {
        const tokenHash = await hashShareId(id);
        // Authorization and thumbnail lookup share one database snapshot; HEAD omits the BLOB.
        const row = await context.env.DB.prepare(`SELECT r.student_id, r.expires_at,
            a.byte_size${head ? '' : ', a.thumbnail'} FROM leave_share_records AS r
            JOIN leave_record_attachments AS a ON a.token_hash = r.token_hash
            WHERE r.token_hash = ?1 AND a.attachment_id = ?2
            ${admin ? '' : 'AND r.revoked_at IS NULL'} LIMIT 1`).bind(tokenHash, aid).first();
        if (!row) return failure('NOT_FOUND', 404);
        if (admin && !canAccess(context.data.adminUser, row)) return failure('FORBIDDEN', 403);
        if (!admin && row.expires_at && Date.parse(row.expires_at) <= Date.now()) return failure('EXPIRED', 410);
        return new Response(head ? null : new Uint8Array(row.thumbnail), { headers: {
            ...PRIVATE_HEADERS, 'Content-Type': 'image/jpeg', 'Content-Length': String(row.byte_size)
        } });
    } catch (error) {
        console.error('Attachment read failed', error.message);
        return failure('SERVICE_UNAVAILABLE', 503);
    }
}
