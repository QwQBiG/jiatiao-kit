import { attachmentManifest } from './leave-attachments.js';

var STATUSES = new Set(['approved', 'pending', 'rejected']);
var REQUIRED = [
    'name', 'studentId', 'gender', 'grade', 'college', 'major', 'className',
    'leaveType', 'approver', 'reason', 'destination', 'startAt', 'endAt'
];

export function fromRow(row) {
    return {
        shareId: row.share_id,
        name: row.name,
        shortName: row.short_name,
        studentId: row.student_id,
        gender: row.gender,
        grade: row.grade,
        college: row.college,
        major: row.major,
        className: row.class_name,
        dorm: row.dorm,
        leaveType: row.leave_type,
        needLeaveSchool: Boolean(row.need_leave_school),
        approver: row.approver,
        reason: row.reason,
        destination: row.destination,
        status: row.status,
        startAt: row.start_at,
        endAt: row.end_at,
        attachments: attachmentManifest(row, row.share_id, true),
        disabled: Boolean(row.revoked_at),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

export function normalizeRecord(input, existing, role) {
    var source = { ...(existing ? fromRow(existing) : {}), ...(input || {}) };
    if (role === 'member' && existing) {
        var allowed = ['leaveType', 'needLeaveSchool', 'reason', 'destination', 'startAt', 'endAt'];
        source = { ...fromRow(existing) };
        allowed.forEach(function (field) {
            if (Object.prototype.hasOwnProperty.call(input || {}, field)) source[field] = input[field];
        });
    }
    REQUIRED.forEach(function (field) {
        if (typeof source[field] !== 'string' || !source[field].trim()) {
            throw new Error('INVALID_' + field.toUpperCase());
        }
        source[field] = source[field].trim();
    });
    source.shortName = String(source.shortName || source.name.slice(-2)).trim();
    source.dorm = String(source.dorm || '-').trim();
    source.status = STATUSES.has(source.status) ? source.status : 'pending';
    source.needLeaveSchool = Boolean(source.needLeaveSchool);
    source.startAt = new Date(source.startAt).toISOString();
    source.endAt = new Date(source.endAt).toISOString();
    if (Date.parse(source.endAt) <= Date.parse(source.startAt)) throw new Error('INVALID_TIME_RANGE');
    return source;
}

export function randomShareId() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
}

export async function hashShareId(value) {
    var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), function (byte) {
        return byte.toString(16).padStart(2, '0');
    }).join('');
}

const RECORD_FIELDS = `share_id, name, short_name, student_id,
    gender, grade, college, major, class_name, dorm, leave_type,
    need_leave_school, approver, reason, destination, status, start_at, end_at,
    created_at, updated_at, revoked_at, attachments_json`;

export const RECORD_SELECT = `SELECT token_hash, ${RECORD_FIELDS} FROM leave_share_records`;
export const RECORD_LIST_SELECT = `SELECT ${RECORD_FIELDS} FROM leave_share_records`;

export function fromStudentRow(row) {
    return {
        studentId: row.student_id, name: row.name, shortName: row.short_name,
        gender: row.gender, grade: row.grade, college: row.college,
        major: row.major, className: row.class_name, dorm: row.dorm,
        recordCount: Number(row.record_count || 0)
    };
}

export const STUDENT_SELECT = `SELECT students.student_id, students.name, students.short_name,
    students.gender, students.grade, students.college, students.major, students.class_name, students.dorm,
    (SELECT COUNT(*) FROM leave_share_records AS records
     WHERE records.student_id = students.student_id) AS record_count FROM students`;

export function canAccess(user, row) {
    return user.role === 'owner' || (row && row.student_id === user.studentId);
}

export function auditStatement(db, user, action, row) {
    return db.prepare(`INSERT INTO admin_audit_log
        (actor_email, action, token_hash, student_id, student_name)
        VALUES (?1, ?2, ?3, ?4, ?5)`)
        .bind(user.email, action, row?.token_hash || null, row?.student_id || null, row?.name || null);
}
