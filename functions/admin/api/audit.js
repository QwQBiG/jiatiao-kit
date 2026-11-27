import { json, methodNotAllowed } from '../../_shared/http.js';

export async function onRequestGet(context) {
    if (context.data.adminUser.role !== 'owner') return json({ error: 'FORBIDDEN' }, 403);
    try {
        var result = await context.env.DB.prepare(`SELECT id, actor_email, action,
            student_id, student_name, created_at FROM admin_audit_log
            ORDER BY id DESC LIMIT 100`).all();
        return json({ logs: result.results || [] });
    } catch (error) {
        console.error('Admin audit list failed', error);
        return json({ error: 'SERVICE_UNAVAILABLE' }, 503);
    }
}

export function onRequest() {
    return methodNotAllowed();
}
