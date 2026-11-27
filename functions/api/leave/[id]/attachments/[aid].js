import { attachmentResponse } from '../../../../_shared/attachment-response.js';

export function onRequest(context) {
    return attachmentResponse(context);
}
