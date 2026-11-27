import { readLeaveRecord, createLeavePayload, unavailableLeaveResult } from '../../_shared/leave-record.js';

var RESPONSE_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store, max-age=0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow, noarchive'
};

function jsonResponse(body, status, timings) {
    var payload = JSON.stringify(body);
    var metrics = ['total;dur=' + (performance.now() - timings.startedAt).toFixed(2)];
    for (var name of ['hash', 'db']) {
        if (typeof timings[name] === 'number') metrics.push(name + ';dur=' + timings[name].toFixed(2));
    }
    var headers = new Headers(RESPONSE_HEADERS);
    headers.set('Server-Timing', metrics.join(', '));
    return new Response(payload, {
        status: status,
        headers: headers
    });
}

export async function onRequestGet(context) {
    var timings = { startedAt: performance.now() };
    try {
        var result = createLeavePayload(await readLeaveRecord(context.params.id, context.env, timings));
        return jsonResponse(result.payload, result.status, timings);
    } catch (error) {
        var failure = unavailableLeaveResult(error);
        return jsonResponse(failure.payload, failure.status, timings);
    }
}

export function onRequest() {
    return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405, { startedAt: performance.now() });
}
