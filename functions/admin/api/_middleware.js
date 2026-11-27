import { requireAdmin } from '../../_shared/access-auth.js';

export async function onRequest(context) {
    var user = await requireAdmin(context);
    if (user instanceof Response) return user;
    context.data.adminUser = user;
    return context.next();
}
