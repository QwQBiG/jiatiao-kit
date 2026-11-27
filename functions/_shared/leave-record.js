import { attachmentManifest } from './leave-attachments.js';

export var ID_PATTERN = /^[0-9a-f]{32}$/i;
var ALLOWED_STATUSES = new Set(['approved', 'pending', 'rejected']);
// Fixed demonstration metadata is independent of individual records.
var RULE_ENABLED_AT = '2026-01-01T00:00:00.000Z';
var RULE_OPERATOR = '演示管理员';

async function measure(timings, name, operation) {
    var startedAt = performance.now();
    try {
        return await operation();
    } finally {
        timings[name] = performance.now() - startedAt;
    }
}

async function sha256Hex(value) {
    var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), function (byte) {
        return byte.toString(16).padStart(2, '0');
    }).join('');
}

function toPublicRecord(row, id) {
    var status = ALLOWED_STATUSES.has(row.status) ? row.status : 'pending';
    return {
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
        status: status,
        approvalLabel: status === 'pending' ? '待处理' : status === 'rejected' ? '未通过' : '已通过',
        startAt: row.start_at,
        endAt: row.end_at,
        attachments: attachmentManifest(row, id),
        ruleEnabledAt: RULE_ENABLED_AT,
        ruleOperator: RULE_OPERATOR
    };
}

export function unavailableLeaveResult(error) {
    console.error('Leave demo query failed', error);
    return { status: 503, payload: { error: 'SERVICE_UNAVAILABLE' } };
}

export async function readLeaveRecord(id, env, timings = {}) {
    var rawId = typeof id === 'string' ? id.toLowerCase() : '';
    if (!ID_PATTERN.test(rawId)) return { status: 400, payload: { error: 'INVALID_ID' } };
    if (!env.DB) return { status: 503, payload: { error: 'SERVICE_NOT_CONFIGURED' } };
    try {
        var tokenHash = await measure(timings, 'hash', () => sha256Hex(rawId));
        var row = await measure(timings, 'db', () => env.DB.prepare(
            `SELECT
                name, short_name, student_id, gender, grade, college, major,
                class_name, dorm, leave_type, need_leave_school, approver,
                reason, destination, status, start_at, end_at, created_at,
                expires_at, attachments_json
             FROM leave_share_records
             WHERE token_hash = ?1 AND revoked_at IS NULL
             LIMIT 1`
        ).bind(tokenHash).first());
        return row ? { row: row, id: rawId } : { status: 404, payload: { error: 'NOT_FOUND' } };
    } catch (error) {
        return unavailableLeaveResult(error);
    }
}

// Validate expiration and timestamp the payload when it is ready to be sent.
export function createLeavePayload(snapshot, now = new Date()) {
    if (!snapshot.row) return snapshot;
    if (snapshot.row.expires_at && Date.parse(snapshot.row.expires_at) <= now.getTime()) {
        return { status: 410, payload: { error: 'EXPIRED' } };
    }
    return { status: 200, payload: {
        demo: true,
        serverNow: now.toISOString(),
        record: toPublicRecord(snapshot.row, snapshot.id)
    } };
}
