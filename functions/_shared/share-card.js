import { cardDetails } from '../../public/share-card/share.js';

export function isSharePage(pathname) {
    return /^\/wec-counselor-leave-apps\/leave\/share\/(?:index(?:\.html)?)?$/.test(pathname);
}

function attribute(value) {
    return String(value).replace(/[&"<>']/g, character => ({
        '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;', "'": '&#39;'
    })[character]);
}

function bootstrapScript(envelope) {
    if (!envelope) return '';
    const json = JSON.stringify(envelope).replace(/[<>&\u2028\u2029]/g,
        character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
    return `<script id="leaveBootstrap" type="application/json">${json}</script>`;
}

function shareHeadReplacements(pageUrl, bootstrap, inline = null) {
    const canonical = new URL(pageUrl);
    // Pages redirects index.html to its directory; cards retain the shared link format.
    if (isSharePage(canonical.pathname)) canonical.pathname = '/wec-counselor-leave-apps/leave/share/index.html';
    const card = cardDetails(canonical.href);
    const replacements = [
        ['__CARD_PAGE_URL__', attribute(card.url)],
        ['__CARD_IMAGE_URL__', attribute(card.imageUrl)]
    ];
    if (bootstrap?.status === 200) {
        // Record parser reception before styles when final-response timing is unavailable.
        replacements.push(['<meta charset="utf-8">', '<meta charset="utf-8">' +
            '<script id="leaveResponseClock">document.currentScript.setAttribute("data-received-at",performance.now());</script>']);
    }
    for (const [tag, value] of inline || []) {
        replacements.push([tag, value]);
        if (tag.includes('\n')) replacements.push([tag.replaceAll('\n', '\r\n'), value]);
    }
    replacements.push(['<!--__LEAVE_BOOTSTRAP__-->', bootstrapScript(bootstrap)]);
    return replacements;
}

// Head metadata and optional initial data leave the visible document intact.
export function renderShareHead(html, pageUrl, bootstrap = null, inline = null) {
    return shareHeadReplacements(pageUrl, bootstrap, inline).reduce(
        (text, [marker, value]) => text.replaceAll(marker, () => value), html);
}

function replaceTextStream(marker, value) {
    let pending = '';
    return new TransformStream({
        transform(chunk, controller) {
            pending += chunk;
            let index;
            while ((index = pending.indexOf(marker)) !== -1) {
                controller.enqueue(pending.slice(0, index) + value);
                pending = pending.slice(index + marker.length);
            }
            // Retain only the tail that could start a marker in the next chunk.
            let retained = Math.min(pending.length, marker.length - 1);
            while (retained > 0 && !pending.endsWith(marker.slice(0, retained))) retained--;
            const ready = pending.length - retained;
            if (ready > 0) {
                controller.enqueue(pending.slice(0, ready));
                pending = pending.slice(ready);
            }
        },
        flush(controller) {
            if (pending) controller.enqueue(pending);
        }
    });
}

export function renderShareHeadStream(body, pageUrl, bootstrap = null, inline = null) {
    if (!body) return null;
    let text = body.pipeThrough(new TextDecoderStream());
    for (const [marker, value] of shareHeadReplacements(pageUrl, bootstrap, inline)) {
        text = text.pipeThrough(replaceTextStream(marker, value));
    }
    return text.pipeThrough(new TextEncoderStream());
}
