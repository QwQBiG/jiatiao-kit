export const CARD_TITLE = '请假';
export const CARD_DESCRIPTION = '请假';
// Project-owned generic calendar, used only as a chat-card placeholder.
export const CARD_IMAGE_PATH = '/share-card/assets/leave-calendar-a3e862826a10.png';
export const PUBLIC_SHARE_ORIGIN = '';
export const SHARE_PAGE_PATH = '/wec-counselor-leave-apps/leave/share/index.html';

export function recordShareUrl(shareId, origin = PUBLIC_SHARE_ORIGIN) {
    if (!/^[0-9a-f]{32}$/i.test(shareId || '')) throw new Error('INVALID_SHARE_ID');
    const base = origin || globalThis.location?.origin || '';
    return `${base}${SHARE_PAGE_PATH}?id=${shareId}&needApproval=&channel=`;
}

export function cardDetails(pageUrl) {
    return { title: CARD_TITLE, text: CARD_DESCRIPTION, url: pageUrl,
        imageUrl: new URL(CARD_IMAGE_PATH, pageUrl).href };
}
