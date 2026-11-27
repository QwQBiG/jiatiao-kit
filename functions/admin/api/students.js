import { json, methodNotAllowed } from '../../_shared/http.js';
import { attachmentManifest, attachmentStatements, attachmentWriteError,
    prepareAttachments, readRecordInput } from '../../_shared/leave-attachments.js';
import {
    RECORD_LIST_SELECT, STUDENT_SELECT, auditStatement, fromRow, fromStudentRow,
    hashShareId, normalizeRecord, randomShareId
} from '../../_shared/admin-records.js';

export async function onRequestGet(context) {
    var user = context.data.adminUser;
    try {
        var query = RECORD_LIST_SELECT;
        var statement;
        var profiles;
        if (user.role === 'owner') {
            statement = context.env.DB.prepare(query + ' ORDER BY student_id, created_at DESC, rowid DESC');
            profiles = context.env.DB.prepare(STUDENT_SELECT + ' ORDER BY student_id');
        } else {
            statement = context.env.DB.prepare(query + ' WHERE student_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 100').bind(user.studentId);
            profiles = context.env.DB.prepare(STUDENT_SELECT + ' WHERE student_id = ?1').bind(user.studentId);
        }
        var [result, students] = await context.env.DB.batch([statement, profiles]);
        return json({
            records: (result.results || []).map(fromRow),
            students: (students.results || []).map(fromStudentRow)
        });
    } catch (error) {
        console.error('Admin record list failed', error);
        return json({ error: 'SERVICE_UNAVAILABLE' }, 503);
    }
}

export async function onRequestPost(context) {
    var user = context.data.adminUser;
    if (!['owner', 'member'].includes(user.role)) return json({ error: 'FORBIDDEN' }, 403);
    try {
        var input = await readRecordInput(context.request);
        var attachments = prepareAttachments(input);
        var record;
        if (user.role === 'member') {
            if (!user.studentId || input.createStudent === true ||
                (Object.hasOwn(input, 'studentId') && input.studentId !== user.studentId)) {
                return json({ error: 'FORBIDDEN' }, 403);
            }
            // Read the current identity and latest leave defaults in one database request.
            var template = await context.env.DB.prepare(`SELECT students.*, records.token_hash,
                records.leave_type, records.need_leave_school, records.approver,
                records.reason, records.destination, records.start_at, records.end_at
                FROM students LEFT JOIN leave_share_records AS records ON records.rowid = (
                    SELECT rowid FROM leave_share_records WHERE student_id = students.student_id
                    ORDER BY created_at DESC, rowid DESC LIMIT 1
                ) WHERE students.student_id = ?1`)
                .bind(user.studentId).first();
            if (!template) return json({ error: 'STUDENT_NOT_FOUND' }, 404);
            if (!template.token_hash) return json({ error: 'LEAVE_TEMPLATE_NOT_FOUND' }, 409);
            // Members publish their own leave immediately; identity and approver stay server-owned.
            record = normalizeRecord(input, { ...template, status: 'approved' }, 'member');
        } else {
            record = normalizeRecord(input, null, 'owner');
            // Explicit creation checks the student primary key in the same batch as the first leave.
            if (input.createStudent !== true) {
                var student = await context.env.DB.prepare('SELECT * FROM students WHERE student_id = ?1')
                    .bind(record.studentId).first();
                if (!student && input.createStudent === false) return json({ error: 'STUDENT_NOT_FOUND' }, 404);
                if (student) record = normalizeRecord({ ...input, ...fromStudentRow(student) }, null, 'owner');
            }
        }
        var shareId = randomShareId();
        var tokenHash = await hashShareId(shareId);
        var now = new Date().toISOString();
        var row = { token_hash: tokenHash, share_id: shareId, student_id: record.studentId, name: record.name };
        var insert = context.env.DB.prepare(`INSERT INTO leave_share_records (
            token_hash, share_id, name, short_name, student_id, gender, grade, college,
            major, class_name, dorm, leave_type, need_leave_school, approver, reason,
            destination, status, start_at, end_at, created_at, updated_at, attachments_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20, ?21)`)
            .bind(tokenHash, shareId, record.name, record.shortName, record.studentId,
                record.gender, record.grade, record.college, record.major, record.className,
                record.dorm, record.leaveType, record.needLeaveSchool ? 1 : 0,
                record.approver, record.reason, record.destination, record.status,
                record.startAt, record.endAt, now, attachments.json);
        var statements = [];
        if (input.createStudent === true) {
            statements.push(context.env.DB.prepare(`INSERT INTO students
                (student_id, name, short_name, gender, grade, college, major, class_name,
                 dorm, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`)
                .bind(record.studentId, record.name, record.shortName, record.gender,
                    record.grade, record.college, record.major, record.className, record.dorm, now));
        }
        statements.push(insert, ...attachmentStatements(context.env.DB, tokenHash, attachments),
            auditStatement(context.env.DB, user, 'create', row));
        await context.env.DB.batch(statements);
        return json({ record: { ...record, shareId, disabled: false, createdAt: now, updatedAt: now,
            attachments: attachmentManifest({ attachments_json: attachments.json }, shareId, true) } }, 201);
    } catch (error) {
        var duplicate = String(error.message).includes('UNIQUE');
        if (!duplicate) console.error('Admin record create failed', error);
        var failure = attachmentWriteError(error);
        return json({ error: duplicate ? 'STUDENT_ALREADY_EXISTS' : failure.error }, duplicate ? 409 : failure.status);
    }
}

export function onRequest() {
    return methodNotAllowed();
}
