import { isSharePage, renderShareHeadStream } from '../../../_shared/share-card.js';
import { ID_PATTERN, readLeaveRecord, createLeavePayload } from '../../../_shared/leave-record.js';
import { SHARE_ASSET_LINK } from '../../../_shared/share-assets.js';
import { loadShareInline } from '../../../_shared/share-inline.js';
import { shareTemplateBody } from '../../../_shared/share-template.js';

export async function onRequest(context) {
    const startedAt = performance.now();
    const url = new URL(context.request.url);
    if (!isSharePage(url.pathname) || !['GET', 'HEAD'].includes(context.request.method)) return context.next();
    // Static template validators do not describe the personalized document.
    const assetUrl = new URL('/wec-counselor-leave-apps/leave/share/', url.origin);
    const assetStartedAt = performance.now();
    let assetMs;
    const assetRequest = context.env.ASSETS.fetch(new Request(assetUrl, { method: context.request.method })).then(response => {
        assetMs = performance.now() - assetStartedAt;
        return response;
    });
    const id = url.searchParams.get('id') || '';
    const timings = {};
    const recordRequest = context.request.method === 'GET' && ID_PATTERN.test(id) && context.env.DB
        ? readLeaveRecord(id, context.env, timings) : null;
    const inlineStartedAt = performance.now();
    let inlineMs;
    const inlineRequest = context.request.method === 'GET' ? loadShareInline(context.env.ASSETS, url).then(result => {
        inlineMs = performance.now() - inlineStartedAt;
        return result;
    }) : null;
    const response = await assetRequest;
    if (response.status !== 200 ||
        !response.headers.get('Content-Type')?.includes('text/html')) return response;
    const template = context.request.method === 'GET'
        ? shareTemplateBody(context.env.ASSETS, assetUrl, response) : { body: null, reused: false };
    const [snapshot, inline] = await Promise.all([recordRequest, inlineRequest]);
    const headers = new Headers(response.headers);
    headers.delete('Content-Length');
    headers.delete('Content-Encoding');
    const acceptedEncoding = context.request.cf?.clientAcceptEncoding
        ?? context.request.headers.get('Accept-Encoding') ?? '';
    const acceptsGzip = acceptedEncoding.split(',').some(value => {
        const match = /^\s*gzip\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/i.exec(value);
        return match && (match[1] === undefined || Number(match[1]) > 0);
    });
    if (acceptsGzip) {
        // The runtime compresses the transformed document using this negotiated encoding.
        headers.set('Content-Encoding', 'gzip');
        headers.append('Vary', 'Accept-Encoding');
    }
    headers.delete('ETag');
    headers.delete('Last-Modified');
    // Preserve the negotiated encoding through intermediaries.
    headers.set('Cache-Control', 'private, no-store, max-age=0' + (acceptsGzip ? ', no-transform' : ''));
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (inline) headers.delete('Link');
    else if (context.request.method === 'GET') headers.set('Link', SHARE_ASSET_LINK);
    // Recheck expiration and anchor the clock after the parallel reads finish.
    const bootstrap = snapshot ? { id: id.toLowerCase(), ...createLeavePayload(snapshot) } : null;
    for (const name of ['hash', 'db']) {
        if (typeof timings[name] === 'number') headers.append('Server-Timing', `${name};dur=${timings[name].toFixed(2)}`);
    }
    if (inlineRequest) headers.append('Server-Timing', `inline;dur=${inlineMs.toFixed(2)}`);
    const assetDescription = context.request.method === 'HEAD' ? 'headers-only' : template.reused ? 'body-reused' : 'body-read';
    headers.append('Server-Timing', `assets;dur=${assetMs.toFixed(2)};desc="${assetDescription}", prepare;dur=${(performance.now() - startedAt).toFixed(2)}`);
    const body = context.request.method === 'HEAD' ? null : renderShareHeadStream(template.body, context.request.url, bootstrap, inline);
    return new Response(body, {
        status: response.status, statusText: response.statusText, headers, encodeBody: 'automatic'
    });
}
