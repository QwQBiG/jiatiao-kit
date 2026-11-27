import { json, methodNotAllowed } from '../../_shared/http.js';

function ownerOnly(context) {
    return context.data.adminUser.role === 'owner';
}

export async function onRequestGet(context) {
    if (!ownerOnly(context)) return json({ error: 'FORBIDDEN' }, 403);
    try {
        var result = await context.env.DB.prepare(`SELECT email, display_name, role,
            student_id, enabled, updated_at FROM admin_members ORDER BY display_name`).all();
        return json({ members: (result.results || []).map(function (row) {
            return {
                email: row.email,
                displayName: row.display_name,
                role: row.role,
                studentId: row.student_id,
                enabled: Boolean(row.enabled),
                updatedAt: row.updated_at
            };
        }) });
    } catch (error) {
        console.error('Admin member list failed', error);
        return json({ error: 'SERVICE_UNAVAILABLE' }, 503);
    }
}

export async function onRequestPost(context) {
    if (!ownerOnly(context)) return json({ error: 'FORBIDDEN' }, 403);
    try {
        var body = await context.request.json();
        var email = String(body.email || '').trim().toLowerCase();
        var displayName = String(body.displayName || '').trim();
        var studentId = String(body.studentId || '').trim();
        if (!/^\S+@\S+\.\S+$/.test(email) || !displayName || !studentId) {
            return json({ error: 'INVALID_MEMBER' }, 400);
        }
        var student = await context.env.DB.prepare(
            'SELECT student_id FROM students WHERE student_id = ?1'
        ).bind(studentId).first();
        if (!student) return json({ error: 'STUDENT_NOT_FOUND' }, 404);
        var now = new Date().toISOString();
        var upsert = context.env.DB.prepare(`INSERT INTO admin_members
            (email, display_name, role, student_id, enabled, updated_at)
            VALUES (?1, ?2, 'member', ?3, 1, ?4)
            ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name,
            role = 'member', student_id = excluded.student_id, enabled = 1,
            updated_at = excluded.updated_at`).bind(email, displayName, studentId, now);
        var audit = context.env.DB.prepare(`INSERT INTO admin_audit_log
            (actor_email, action, student_id, student_name) VALUES (?1, 'member_upsert', ?2, ?3)`)
            .bind(context.data.adminUser.email, studentId, displayName);
        await context.env.DB.batch([upsert, audit]);
        return json({ member: { email, displayName, role: 'member', studentId, enabled: true } });
    } catch (error) {
        console.error('Admin member upsert failed', error);
        var duplicate = String(error.message).includes('UNIQUE');
        return json({ error: duplicate ? 'STUDENT_ALREADY_BOUND' : 'SERVICE_UNAVAILABLE' }, duplicate ? 409 : 503);
    }
}

export async function onRequestPatch(context) {
    if (!ownerOnly(context)) return json({ error: 'FORBIDDEN' }, 403);
    try {
        var body = await context.request.json();
        var email = String(body.email || '').trim().toLowerCase();
        var enabled = body.enabled ? 1 : 0;
        if (!email) return json({ error: 'INVALID_MEMBER' }, 400);
        var update = context.env.DB.prepare(
            'UPDATE admin_members SET enabled = ?1, updated_at = ?2 WHERE email = ?3'
        ).bind(enabled, new Date().toISOString(), email);
        var audit = context.env.DB.prepare(`INSERT INTO admin_audit_log
            (actor_email, action, student_name) VALUES (?1, 'member_disable', ?2)`)
            .bind(context.data.adminUser.email, email);
        await context.env.DB.batch([update, audit]);
        return json({ ok: true, enabled: Boolean(enabled) });
    } catch (error) {
        console.error('Admin member state change failed', error);
        return json({ error: 'SERVICE_UNAVAILABLE' }, 503);
    }
}

export function onRequest() {
    return methodNotAllowed();
}
