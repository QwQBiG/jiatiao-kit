const MAX_TEMPLATE_BYTES = 64 * 1024;
const SHARE_PATH = '/wec-counselor-leave-apps/leave/share/';
const completedTemplates = new WeakMap();

// Only unmodified public template bytes enter this cache, before record injection.
export function shareTemplateBody(assets, assetUrl, response) {
    const original = { body: response.body, reused: false };
    const url = new URL(assetUrl);
    const etag = response.headers.get('ETag');
    const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    const encoding = response.headers.get('Content-Encoding');
    const length = response.headers.get('Content-Length');
    if (url.pathname !== SHARE_PATH || url.search || url.hash || response.status !== 200 ||
        mime !== 'text/html' || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag || '') ||
        response.headers.has('Set-Cookie') || response.headers.has('Content-Range') ||
        (encoding && encoding.toLowerCase() !== 'identity') || !response.body ||
        (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_TEMPLATE_BYTES))) return original;

    const cached = completedTemplates.get(assets);
    if (cached?.origin === url.origin && cached.etag === etag &&
        (length === null || Number(length) === cached.bytes.byteLength)) {
        // The current response still supplies its fresh status and headers.
        response.body.cancel().catch(() => {});
        return { body: new Response(cached.bytes.slice()).body, reused: true };
    }

    let chunks = [], size = 0;
    const body = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            controller.enqueue(chunk);
            if (!chunks) return;
            size += chunk.byteLength;
            if (size > MAX_TEMPLATE_BYTES) chunks = null;
            else chunks.push(chunk.slice());
        },
        flush() {
            if (!chunks || (length !== null && size !== Number(length))) return;
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            let html;
            try { html = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
            catch { return; }
            // ASSETS may omit Content-Length; an incomplete shell must remain uncached.
            if (!/<\/html>\s*$/i.test(html) || !html.includes('<!--__LEAVE_BOOTSTRAP__-->') ||
                !html.includes('__CARD_PAGE_URL__') || !html.includes('__CARD_IMAGE_URL__') ||
                /<script\b[^>]*\bid=["']leaveBootstrap["']/i.test(html)) return;
            completedTemplates.set(assets, { origin: url.origin, etag, bytes });
        }
    }));
    return { body, reused: false };
}
