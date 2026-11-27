import { json, methodNotAllowed } from '../../../_shared/http.js';
import { attachmentManifest, attachmentStatements, attachmentWriteError,
    prepareAttachments, readRecordInput } from '../../../_shared/leave-attachments.js';
import {
    RECORD_SELECT, auditStatement, canAccess, fromRow, normalizeRecord
} from '../../../_shared/admin-records.js';

async function findRecord(context) {
    return context.env.DB.prepare(RECORD_SELECT + ' WHERE share_id = ?1 LIMIT 1')
        .bind(String(context.params.id || '').toLowerCase()).first();
}

export async function onRequestGet(context) {
    try {
        var row = await findRecord(context);
        if (!row) return json({ error: 'NOT_FOUND' }, 404);
        if (!canAccess(context.data.adminUser, row)) return json({ error: 'FORBIDDEN' }, 403);
        return json({ record: fromRow(row) });
    } catch (error) {
        console.error('Admin record read failed', error);
        return json({ error: 'SERVICE_UNAVAILABLE' }, 503);
    }
}

export async function onRequestPut(context) {
    try {
        var user = context.data.adminUser;
        var row = await findRecord(context);
        if (!row) return json({ error: 'NOT_FOUND' }, 404);
        if (!canAccess(user, row)) return json({ error: 'FORBIDDEN' }, 403);
        var input = await readRecordInput(context.request);
        var attachments = prepareAttachments(input, row);
        var record = normalizeRecord(input, row, user.role);
        var now = new Date().toISOString();
        var update = context.env.DB.prepare(`UPDATE leave_share_records SET
            name = ?1, short_name = ?2, student_id = ?3, gender = ?4, grade = ?5,
            college = ?6, major = ?7, class_name = ?8, dorm = ?9, leave_type = ?10,
            need_leave_school = ?11, approver = ?12, reason = ?13, destination = ?14,
            status = ?15, start_at = ?16, end_at = ?17, updated_at = ?18, attachments_json = ?19
            WHERE token_hash = ?20`)
            .bind(record.name, record.shortName, record.studentId, record.gender,
                record.grade, record.college, record.major, record.className, record.dorm,
                record.leaveType, record.needLeaveSchool ? 1 : 0, record.approver,
                record.reason, record.destination, record.status, record.startAt,
                record.endAt, now, attachments.json, row.token_hash);
        var auditRow = { ...row, student_id: record.studentId, name: record.name };
        await context.env.DB.batch([...attachmentStatements(context.env.DB, row.token_hash, attachments, row),
            update, auditStatement(context.env.DB, user, 'update', auditRow)]);
        return json({ record: { ...record, shareId: row.share_id, disabled: Boolean(row.revoked_at), updatedAt: now,
            attachments: attachmentManifest({ attachments_json: attachments.json }, row.share_id, true) } });
    } catch (error) {
        console.error('Admin record update failed', error);
        var duplicate = String(error.message).includes('UNIQUE');
        var failure = attachmentWriteError(error);
        return json({ error: duplicate ? 'STUDENT_ALREADY_EXISTS' : failure.error }, duplicate ? 409 : failure.status);
    }
}

export async function onRequestPatch(context) {
    var user = context.data.adminUser;
    if (user.role !== 'owner') return json({ error: 'FORBIDDEN' }, 403);
    try {
        var body = await context.request.json();
        if (!['disable', 'restore'].includes(body.action)) return json({ error: 'INVALID_ACTION' }, 400);
        var row = await findRecord(context);
        if (!row) return json({ error: 'NOT_FOUND' }, 404);
        var revokedAt = body.action === 'disable' ? new Date().toISOString() : null;
        var update = context.env.DB.prepare(
            'UPDATE leave_share_records SET revoked_at = ?1, updated_at = ?2 WHERE token_hash = ?3'
        ).bind(revokedAt, new Date().toISOString(), row.token_hash);
        await context.env.DB.batch([update, auditStatement(context.env.DB, user, body.action, row)]);
        return json({ ok: true, disabled: Boolean(revokedAt) });
    } catch (error) {
        console.error('Admin record state change failed', error);
        return json({ error: 'SERVICE_UNAVAILABLE' }, 503);
    }
}

export function onRequest() {
    return methodNotAllowed();
}
