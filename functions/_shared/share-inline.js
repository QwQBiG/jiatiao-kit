import { SHARE_ASSET_LINK } from './share-assets.js';
import { appendIconSubset } from './share-icon-subset.js';

const SHARE_ROOT = '/wec-counselor-leave-apps/leave/share/';
const publicResources = new WeakMap();
const INLINE_BUDGET_MS = 400;
const resources = [...SHARE_ASSET_LINK.matchAll(/<([^>]+)>;\s*rel=preload;\s*as=(style|script)/g)]
    .map(([, path, type]) => ({ path, type }));

export function rewriteShareCss(source, assetUrl) {
    return source.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (match, quoted, single, plain) => {
        const value = (quoted ?? single ?? plain).trim();
        if (!value || value.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(value)) return match;
        // The bundled styles use ordinary relative URLs; keep unfamiliar escapes external.
        if (value.includes('\\')) throw new Error('Unsupported escaped CSS URL');
        const url = new URL(value, assetUrl);
        return `url("${url.pathname}${url.search}${url.hash}")`;
    });
}

function originalTag(resource, index) {
    const relative = resource.path.startsWith(SHARE_ROOT)
        ? './' + resource.path.slice(SHARE_ROOT.length) : resource.path;
    if (resource.type === 'script') return `<script src="${relative}" async fetchpriority="high"></script>`;
    return index < 2 ? `<link\n        href="${relative}"\n        rel="stylesheet">`
        : `<link rel="stylesheet" href="${relative}">`;
}

async function fetchPublicResources(assets, pageUrl, signal) {
    if (resources.length !== 4 || resources.filter(resource => resource.type === 'style').length !== 3) return null;
    try {
        const replacements = await Promise.all(resources.map(async (resource, index) => {
            if (!resource.path.startsWith(SHARE_ROOT) &&
                !resource.path.startsWith('/theme-placeholder/') &&
                !resource.path.startsWith('/local-theme/share/assets/')) throw new Error('Unexpected public resource path');
            const url = new URL(resource.path, pageUrl);
            // Do not forward the navigation's ID, cookies, authorization or conditional headers.
            const response = await assets.fetch(new Request(url, { method: 'GET', signal }));
            const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
            const valid = resource.type === 'style' ? mime === 'text/css'
                : ['text/javascript', 'application/javascript'].includes(mime);
            if (response.status !== 200 || !valid) {
                await response.body?.cancel();
                throw new Error('Public resource unavailable');
            }
            const source = await response.text();
            let replacement;
            if (resource.type === 'style') {
                if (/<\/style\b/i.test(source)) throw new Error('Stylesheet requires an external resource');
                replacement = '<style>' + appendIconSubset(rewriteShareCss(source, url), url) + '</style>';
            } else {
                // Preserve the complete script verbatim; fall back for HTML raw-text delimiters.
                if (/<(?:\/script\b|!--)/i.test(source)) throw new Error('Script requires an external resource');
                const version = url.searchParams.get('v');
                if (!/^[0-9a-f]{12}$/.test(version || '')) throw new Error('Missing script fingerprint');
                replacement = `<script data-share-app-version="${version}">${source}</script>`;
            }
            return [originalTag(resource, index), replacement];
        }));
        return replacements;
    } catch {
        return null;
    }
}

export async function loadShareInline(assets, pageUrl) {
    let entry = publicResources.get(assets);
    if (entry?.replacements) return entry.replacements;
    let controller;
    if (!entry) {
        controller = new AbortController();
        entry = { pending: fetchPublicResources(assets, pageUrl, controller.signal) };
        publicResources.set(assets, entry);
    }
    // Each navigation can fall back even if the request that started the shared read disconnects.
    let timer;
    try {
        const result = await Promise.race([entry.pending, new Promise(resolve => {
            timer = setTimeout(() => resolve(null), INLINE_BUDGET_MS);
        })]);
        if (publicResources.get(assets) === entry) {
            if (result) publicResources.set(assets, { replacements: result });
            else publicResources.delete(assets);
        }
        if (!result) controller?.abort();
        return result;
    } finally {
        clearTimeout(timer);
    }
}
