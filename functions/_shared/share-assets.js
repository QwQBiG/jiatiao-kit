const SHARE_ROOT = '/wec-counselor-leave-apps/leave/share/';

// Keep these public resource paths in sync with the share HTML and script fingerprint.
export const SHARE_ASSET_LINK = [
    `</theme-placeholder/common.css>; rel=preload; as=style`,
    `</theme-placeholder/vendor.css>; rel=preload; as=style`,
    `</theme-placeholder/icons.css>; rel=preload; as=style`,
    `<${SHARE_ROOT}app.js?v=6360aaf16aa4>; rel=preload; as=script; fetchpriority=high`
].join(', ');
