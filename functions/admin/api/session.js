import { json, methodNotAllowed } from '../../_shared/http.js';

export function onRequestGet(context) {
    return json({ user: context.data.adminUser });
}

export function onRequest() {
    return methodNotAllowed();
}
