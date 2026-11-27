import { buildIndex, filterStudents, paginate, mergeRecordData } from './admin-model.js?v=polish-1';
import { recordShareUrl } from '/share-card/share.js?v=3';
import { MAX_ATTACHMENTS, createAttachmentThumbnail, validateSourceFile } from './attachment-thumbnails.js?v=attachments-1';
const state = {
    session: null, students: [], records: [], members: [], logs: [], editing: null,
    creatingFor: null, historyStudentId: null, studentPage: 1, historyPage: 1, selfPage: 1,
    filter: 'all', sort: 'studentId', revision: 0, memberRevision: 0, membersLoaded: false, logsLoaded: false,
    ready: false, refreshing: false, pending: new Set(), index: buildIndex([], []), tab: 'students', newOwnRecordId: null
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const formBaselines = new WeakMap();
const lockedControls = new WeakMap();
const attachmentDrafts = new WeakMap();
let attachmentSequence = 0;

function formValues(form) {
    return JSON.stringify([...form.elements].filter(element => element.name)
        .map(element => [element.name, element.value]).concat(form.id === 'studentForm'
            ? [['attachments', (attachmentDrafts.get(form)?.items || []).map(item => item.id || item.key)]] : []));
}

function trackForm(form) {
    formBaselines.set(form, formValues(form));
}

function setFormBusy(form, busy) {
    if (busy) {
        const controls = [...form.querySelectorAll('input, select, textarea, [data-close], [data-attachment-action]')];
        lockedControls.set(form, controls.map(element => [element, element.disabled]));
        controls.forEach(element => { element.disabled = true; });
        form.setAttribute('aria-busy', 'true');
    } else {
        for (const [element, disabled] of lockedControls.get(form) || []) element.disabled = disabled;
        lockedControls.delete(form);
        form.removeAttribute('aria-busy');
    }
}

function requestClose(dialog) {
    if (saving(dialog)) return;
    const form = dialog.querySelector('form');
    const changed = formBaselines.has(form) && formBaselines.get(form) !== formValues(form);
    if (changed && !confirm('有未保存的修改，确定放弃吗？')) return;
    dialog.close();
}

let viewStorageKey = '', viewSaveTimer;

function updateFilterButtons() {
    $$('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)));
}

function persistView() {
    clearTimeout(viewSaveTimer);
    if (!viewStorageKey) return;
    try {
        sessionStorage.setItem(viewStorageKey, JSON.stringify({ tab: state.tab, query: $('#searchInput').value,
            filter: state.filter, sort: state.sort, page: state.studentPage }));
    } catch { /* Remembering the view is optional when browser storage is unavailable. */ }
}

function queueViewSave() {
    clearTimeout(viewSaveTimer);
    viewSaveTimer = setTimeout(persistView, 150);
}

function restoreView() {
    viewStorageKey = '';
    if (state.session.role !== 'owner') return;
    viewStorageKey = `leave-admin:view:${state.session.role}:${state.session.email}`;
    try {
        const saved = JSON.parse(sessionStorage.getItem(viewStorageKey) || 'null');
        if (!saved || typeof saved !== 'object') return;
        if (['students', 'members', 'audit'].includes(saved.tab)) state.tab = saved.tab;
        if (['all', 'active', 'disabled'].includes(saved.filter)) state.filter = saved.filter;
        if (['studentId', 'updated'].includes(saved.sort)) state.sort = saved.sort;
        if (Number.isSafeInteger(saved.page) && saved.page > 0) state.studentPage = saved.page;
        if (typeof saved.query === 'string') $('#searchInput').value = saved.query;
        $('#sortSelect').value = state.sort;
        updateFilterButtons();
    } catch { /* Use the default view if storage is blocked or its contents are invalid. */ }
}

window.addEventListener('pagehide', persistView);

const pendingRequests = new Map();
const api = async (path, options = {}) => {
    const read = !options.method || options.method === 'GET';
    if (read && pendingRequests.has(path)) return pendingRequests.get(path);
    const request = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
            const response = await fetch(`/admin/api/${path}`, {
                ...options, signal: controller.signal, cache: 'no-store',
                headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
            });
            if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('AUTH_REQUIRED');
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || `HTTP_${response.status}`);
            return body;
        } catch (error) {
            if (controller.signal.aborted) throw new Error('REQUEST_TIMEOUT');
            throw error;
        } finally { clearTimeout(timer); }
    })();
    if (read) pendingRequests.set(path, request);
    try { return await request; }
    finally { if (read && pendingRequests.get(path) === request) pendingRequests.delete(path); }
};
const timeFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const detailTimeFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function errorText(error) {
    return ({ AUTH_REQUIRED: '登录已过期，请重新打开后台登录。', NOT_AUTHORIZED: '当前邮箱尚未获得权限，请联系主管。',
        FORBIDDEN: '当前账号没有此项操作权限。', SERVICE_UNAVAILABLE: '服务暂时不可用，请稍后重试。',
        REQUEST_TIMEOUT: '请求超时，请先刷新确认结果，避免重复保存。',
        STUDENT_ALREADY_EXISTS: '该学号已存在，请使用“新增请假”。', STUDENT_ALREADY_BOUND: '该学号已绑定邮箱，请检查已有成员。',
        STUDENT_NOT_FOUND: '学生档案不存在，请联系主管。', LEAVE_TEMPLATE_NOT_FOUND: '请先由主管建立首条请假记录，以配置审批人。',
        NOT_FOUND: '记录已不存在，请刷新列表。',
        ATTACHMENT_EMPTY: '图片文件为空，请重新选择。', ATTACHMENT_TYPE: '请选择 JPG、PNG 或 WebP 图片。',
        ATTACHMENT_SOURCE_TOO_LARGE: '原图片超过 10 MB，请先缩小后再选择。',
        ATTACHMENT_DIMENSIONS: '原图片分辨率过大，请先缩小后再选择。',
        ATTACHMENT_DECODE: '图片无法读取，请换一张 JPG、PNG 或 WebP 图片。',
        ATTACHMENT_ENCODE: '暂时无法生成小图，请重新选择或换一张图片。',
        ATTACHMENT_TOO_LARGE: '图片压缩后仍然过大，请先缩小后再选择。',
        ATTACHMENT_LIMIT: '每条请假最多添加 3 张图片。',
        INVALID_ATTACHMENTS: '附件格式无效，请检查图片后重试。',
        INVALID_ATTACHMENT: '附件图片无效，请重新选择后重试。',
        ATTACHMENT_COUNT_EXCEEDED: '每条请假最多添加 3 张图片。',
        ATTACHMENT_LIMIT_EXCEEDED: '每条请假最多添加 3 张图片。',
        ATTACHMENT_JPEG_ONLY: '请重新选择图片并生成 JPEG 小图后重试。',
        INVALID_ATTACHMENT_JPEG: '附件图片无法读取，请重新选择后重试。',
        ATTACHMENT_DIMENSIONS_EXCEEDED: '附件尺寸过大，请重新选择生成小图后重试。',
        ATTACHMENT_NOT_FOUND: '附件已不存在，请刷新记录后重试。',
        INVALID_ATTACHMENT_REFERENCE: '附件已发生变化，请刷新记录后重试；当前输入已保留。',
        ATTACHMENT_CONFLICT: '附件已被其他操作更新，请刷新记录后重试；当前输入已保留。',
        ATTACHMENT_QUOTA_EXCEEDED: '附件存储空间不足，请删除不需要的附件后重试。',
        BODY_TOO_LARGE: '提交内容过大，请减少附件后重试。' })[error.message]
        || (error instanceof TypeError ? '网络连接失败，请先刷新确认结果。' : error.message);
}

function attachmentEditorMarkup() {
    return `<fieldset class="editor-section attachment-editor"><legend>附件图片（选填）</legend>
        <p class="attachment-hint">最多 3 张，仅保存小图，不上传原图。</p>
        <div class="attachment-list" id="attachmentList"></div>
        <input class="sr-only" id="attachmentInput" type="file" accept="image/jpeg,image/png,image/webp" multiple>
        <div class="attachment-controls"><button class="ghost" type="button" data-attachment-action="add">添加图片</button>
        <span id="attachmentCount" class="attachment-hint"></span></div>
        <p id="attachmentMessage" class="attachment-message" role="status" aria-live="polite" hidden></p></fieldset>`;
}

function showAttachmentMessage(message = '', failed = false) {
    const element = $('#attachmentMessage');
    if (!element) return;
    element.textContent = message; element.hidden = !message;
    element.classList.toggle('is-error', failed);
}

function renderAttachmentDraft() {
    const form = $('#studentForm'), draft = attachmentDrafts.get(form);
    if (!draft || !$('#attachmentList')) return;
    const list = $('#attachmentList');
    list.replaceChildren();
    draft.items.forEach((item, index) => {
        const card = document.createElement('div'); card.className = 'attachment-item';
        const image = document.createElement('img');
        image.src = item.data || item.url; image.alt = `附件小图 ${index + 1}`;
        image.width = image.height = 72;
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'ghost attachment-remove';
        remove.dataset.attachmentAction = 'remove'; remove.dataset.attachmentIndex = String(index);
        remove.textContent = '删除'; remove.setAttribute('aria-label', `删除附件 ${index + 1}`);
        remove.disabled = draft.processing || form.hasAttribute('aria-busy');
        card.append(image, remove); list.append(card);
    });
    $('#attachmentCount').textContent = `${draft.items.length} / ${MAX_ATTACHMENTS}`;
    $('[data-attachment-action="add"]').disabled = draft.processing || form.hasAttribute('aria-busy') || draft.items.length >= MAX_ATTACHMENTS;
}

async function addAttachments(input) {
    const form = $('#studentForm'), draft = attachmentDrafts.get(form), button = $('#saveStudentButton');
    const files = [...input.files]; input.value = '';
    if (!draft || draft.processing || button.disabled || !files.length) return;
    try {
        if (draft.items.length + files.length > MAX_ATTACHMENTS) throw new Error('ATTACHMENT_LIMIT');
        files.forEach(file => {
            try { validateSourceFile(file); }
            catch (error) { throw new Error(`${file.name}：${errorText(error)}`); }
        });
    } catch (error) { showAttachmentMessage(errorText(error), true); return; }
    const label = button.textContent;
    draft.processing = true; button.disabled = true; button.textContent = '处理图片…';
    setFormBusy(form, true); showAttachmentMessage('正在生成小图…');
    try {
        for (const file of files) {
            let thumbnail;
            try { thumbnail = await createAttachmentThumbnail(file); }
            catch (error) { throw new Error(`${file.name}：${errorText(error)}`); }
            if (attachmentDrafts.get(form) !== draft) return;
            draft.items.push({ key: `local-${++attachmentSequence}`, ...thumbnail });
        }
        showAttachmentMessage('小图已准备好，保存后生效。');
    } catch (error) { showAttachmentMessage(errorText(error), true); }
    finally {
        draft.processing = false;
        setFormBusy(form, false); button.disabled = false; button.textContent = label;
        renderAttachmentDraft();
    }
}

function notice(message = '') {
    $('#noticeText').textContent = message;
    $('#pageNotice').hidden = !message;
}

function synced(message = '已同步') {
    $('#syncStatus').textContent = `${message} · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

const fields = [
    ['name', '姓名', 'text', true, false], ['shortName', '简称', 'text', false, false],
    ['studentId', '学号', 'text', true, false], ['gender', '性别', 'text', true, false],
    ['grade', '年级', 'text', true, false], ['college', '学院', 'text', true, false],
    ['major', '专业', 'text', true, false], ['className', '班级', 'text', true, false],
    ['dorm', '宿舍', 'text', false, false], ['leaveType', '请假类型', 'text', true, true],
    ['approver', '审批人', 'text', true, false], ['status', '状态', 'select', true, false],
    ['startAt', '开始时间', 'datetime-local', true, true], ['endAt', '结束时间', 'datetime-local', true, true],
    ['destination', '外出地点', 'textarea', true, true], ['reason', '请假原因', 'textarea', true, true],
    ['needLeaveSchool', '需要离校', 'checkbox', false, true]
];

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
}

function showToast(message) {
    const toast = $('#toast');
    const host = document.activeElement?.closest('dialog[open]') || $$('dialog[open]').at(-1) || document.body;
    host.append(toast);
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function localDate(value) {
    if (!value) return '';
    const date = new Date(value);
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function shortTime(value) {
    if (!value) return '—';
    return timeFormat.format(new Date(value));
}

function fullTime(value) {
    return value ? detailTimeFormat.format(new Date(value)) : '—';
}

function statusText(status) {
    return { approved: '已通过', pending: '待处理', rejected: '未通过' }[status] || status;
}

function shareUrl(record) {
    return recordShareUrl(record.shareId);
}

function openLinkDialog(record) {
    const url = shareUrl(record);
    $('#shareLink').value = url;
    $('#openShareLink').href = url;
    if (!$('#shareDialog').open) $('#shareDialog').showModal();
}

function applyRole() {
    const owner = state.session.role === 'owner';
    if (!owner) $$('.owner-only').forEach((element) => element.hidden = true);
    $$('.member-only').forEach((element) => element.hidden = owner);
    $('#accountText').textContent = `${state.session.email} · ${owner ? '主管' : '成员'}`;
    $('#welcomeTitle').textContent = owner ? '主管数据工作台' : '我的请假数据';
    $('#welcomeText').textContent = owner
        ? '维护全部学生、成员权限和操作记录。'
        : '新增、查看和修改本人的请假；保存后直接生效并生成独立链接。';
    $('#studentPanelTitle').textContent = owner ? '学生记录' : '本人记录';
    $('#studentPanelHint').textContent = owner ? '列表显示最新请假；查看记录可管理更早的内容。' : '身份与审批字段由主管维护。';
}

function commitStudents(data) {
    state.records = data.records;
    state.students = data.students;
    state.index = buildIndex(state.students, state.records);
    state.ready = true;
    document.body.removeAttribute('data-loading');
    $('#addStudentButton').disabled = false;
    $('#addOwnLeaveButton').disabled = !state.students.some(student => student.studentId === state.session.studentId);
    renderStudents();
    $('#studentCount').textContent = state.students.length;
    $('#activeCount').textContent = state.records.filter((record) => !record.disabled).length;
    if ($('#historyDialog').open) renderHistory();
    if (state.session.role === 'owner') renderMemberOptions();
}

async function loadStudents() {
    const revision = state.revision;
    const data = await api('students');
    // A slower refresh must not overwrite a newer, confirmed save response.
    if (revision === state.revision) commitStudents(data);
}

function renderPager(id, result, target) {
    const pager = $(id);
    pager.hidden = !result.total;
    pager.innerHTML = `<span>显示 ${result.start}–${result.end} 条，共 ${result.total} 条</span>${result.pages > 1 ? `<div>
        <button class="ghost" type="button" data-page-target="${target}" data-page="${result.page - 1}" ${result.page === 1 ? 'disabled' : ''}>上一页</button>
        <span>${result.page} / ${result.pages}</span><button class="ghost" type="button" data-page-target="${target}" data-page="${result.page + 1}" ${result.page === result.pages ? 'disabled' : ''}>下一页</button></div>` : ''}`;
}

function renderStudents() {
    if (!state.ready) return;
    if (state.session.role !== 'owner') {
        renderSelfEditor(state.records);
        return;
    }
    const result = paginate(filterStudents(state.index.summaries, $('#searchInput').value, state.filter, state.sort), state.studentPage);
    state.studentPage = result.page;
    $('#studentRows').innerHTML = result.items.map((record) => `
        <tr>
            <td><div class="student-cell"><span class="avatar">${escapeHtml((record.shortName || record.name).slice(0, 1))}</span>
                <div><strong>${escapeHtml(record.name)}</strong><small>${escapeHtml(record.studentId)}</small>
                <button class="history-link" type="button" data-history="${escapeHtml(record.studentId)}">查看 ${record.recordCount} 条记录 <span aria-hidden="true">›</span></button></div></div></td>
            <td><div class="date-range">${shortTime(record.startAt)}<span>→ ${shortTime(record.endAt)}</span></div></td>
            <td>${badgeMarkup(record)}</td>
            <td>${shortTime(record.updatedAt)}</td>
            <td><div class="actions">
                <button class="row-action action-primary" type="button" data-new-leave="${escapeHtml(record.studentId)}"><svg class="ui-icon" aria-hidden="true"><use href="#i-plus"/></svg>新增请假</button>
                ${record.shareId ? `<button class="row-action" type="button" data-copy="${record.shareId}" title="复制${escapeHtml(record.name)}的最新请假链接">复制链接</button>
                <button class="row-action" type="button" data-edit="${record.shareId}" ${state.pending.has(record.shareId) ? 'disabled' : ''}>编辑最新记录</button>
                <button class="row-action danger" type="button" data-state="${record.shareId}" data-action="${record.disabled ? 'restore' : 'disable'}" ${state.pending.has(record.shareId) ? 'disabled' : ''}>${record.disabled ? '恢复最新记录' : '停用最新记录'}</button>` : ''}
            </div></td>
        </tr>`).join('');
    $('#studentEmpty').hidden = result.total > 0;
    $('#resetFiltersButton').hidden = !$('#searchInput').value.trim() && state.filter === 'all';
    renderPager('#studentPager', result, 'studentPage');
}

function badgeMarkup(record) {
    const style = record.disabled ? 'off' : record.status === 'pending' ? 'pending' : record.status === 'rejected' ? 'rejected' : '';
    return `<span class="badge ${style}">${record.disabled ? '已停用' : escapeHtml(statusText(record.status) || '暂无记录')}</span>`;
}

function leaveTimeState(record, now = Date.now()) {
    if (record.disabled || record.status !== 'approved') return null;
    const start = Date.parse(record.startAt), end = Date.parse(record.endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    if (now < start) return { key: 'upcoming', label: '即将开始' };
    if (now <= end) return { key: 'ongoing', label: '进行中' };
    return { key: 'completed', label: '已完成' };
}

let timeStateTimer;
function updateTimeStates() {
    if (state.session?.role !== 'member') return;
    const now = Date.now();
    $$('#selfEditor [data-time-state]').forEach(element => {
        const record = state.index.byId.get(element.closest('[data-record]').dataset.record);
        const phase = record ? leaveTimeState(record, now) : null;
        element.hidden = !phase;
        if (element.dataset.timeState !== (phase?.key || '')) element.dataset.timeState = phase?.key || '';
        const text = phase ? `时间：${phase.label}` : '';
        if (element.textContent !== text) element.textContent = text;
    });
}

function maintainTimeStates() {
    if (document.hidden || state.session?.role !== 'member') {
        clearInterval(timeStateTimer); timeStateTimer = null;
        return;
    }
    updateTimeStates();
    if (!timeStateTimer) timeStateTimer = setInterval(updateTimeStates, 1000);
}
document.addEventListener('visibilitychange', maintainTimeStates);

function focusNewOwnRecord(id) {
    const card = $(`#selfEditor [data-record="${id}"]`);
    if (!card) return;
    card.scrollIntoView({ block: 'start' });
    card.focus({ preventScroll: true });
    card.classList.add('new-record-highlight');
    setTimeout(() => card.classList.remove('new-record-highlight'), 4000);
}

function recordCard(record, owner = false) {
    const pending = state.pending.has(record.shareId) ? 'disabled' : '';
    const phase = owner ? null : leaveTimeState(record);
    const newlyCreated = !owner && record.shareId === state.newOwnRecordId;
    return `<article class="member-card record-card" data-record="${record.shareId}" ${newlyCreated ? 'data-new-record tabindex="-1"' : ''}>
        <div class="record-heading"><h3>${escapeHtml(record.leaveType)}</h3>${badgeMarkup(record)}</div>
        ${owner ? '' : `<p class="record-timing" data-time-state="${phase?.key || ''}" ${phase ? '' : 'hidden'}>${phase ? `时间：${phase.label}` : ''}</p>`}
        <p class="record-range">${shortTime(record.startAt)} → ${shortTime(record.endAt)}</p>
        <p class="record-reason">${escapeHtml(record.reason)}</p>
        <p class="record-meta">创建 ${fullTime(record.createdAt)} · ${record.needLeaveSchool ? '需要离校' : '无需离校'}</p>
        <footer><div class="actions"><button class="row-action${newlyCreated ? ' action-primary' : ''}" type="button" data-copy="${record.shareId}">${newlyCreated ? '复制新链接' : '复制链接'}</button>
        <button class="row-action" type="button" data-edit="${record.shareId}" ${pending}>${owner ? '编辑记录' : '修改本人内容'}</button>
        ${owner ? `<button class="row-action danger" type="button" data-state="${record.shareId}" data-action="${record.disabled ? 'restore' : 'disable'}" ${pending}>${record.disabled ? '恢复此条链接' : '停用此条链接'}</button>` : ''}</div></footer></article>`;
}

function renderSelfEditor(records) {
    const container = $('#selfEditor');
    const record = state.students[0];
    if (!record) {
        container.innerHTML = '<div class="empty">当前账号尚未绑定学生记录，请联系主管。</div>';
        return;
    }
    container.innerHTML = `<div class="self-summary"><h3>${escapeHtml(record.name)} · ${escapeHtml(record.studentId)}</h3>
        <p>${escapeHtml(record.college)} / ${escapeHtml(record.className)}</p></div>
        <p>已保留 ${records.length}/100 条请假记录，最新记录在前。</p>
        <div class="cards">${paginate(records, state.selfPage, 10).items.map(record => recordCard(record)).join('') || '<div class="empty">暂无请假记录</div>'}</div>
        <div class="list-pager" id="selfPager"></div>`;
    const result = paginate(records, state.selfPage, 10);
    state.selfPage = result.page;
    renderPager('#selfPager', result, 'selfPage');
    maintainTimeStates();
}

function renderHistory() {
    const student = state.students.find(student => student.studentId === state.historyStudentId);
    const records = state.index.byStudent.get(state.historyStudentId) || [];
    const result = paginate(records, state.historyPage, 10);
    state.historyPage = result.page;
    $('#historyTitle').textContent = student ? `${student.name} · 请假记录（${records.length}/100）` : '请假记录';
    $('#historyRecords').innerHTML = result.items.map(record => recordCard(record, true)).join('')
        || '<div class="empty">暂无请假记录</div>';
    renderPager('#historyPager', result, 'historyPage');
}

function inputMarkup(field, record, memberMode, lockProfile = false) {
    const [name, label, type, required, memberEditable] = field;
    const profileFields = ['name', 'shortName', 'studentId', 'gender', 'grade', 'college', 'major', 'className', 'dorm'];
    const readonly = (memberMode && !memberEditable) || (lockProfile && profileFields.includes(name));
    const value = type === 'datetime-local' ? localDate(record?.[name]) : (record?.[name] ?? '');
    if (type === 'select') return `<label>${label}${required ? ' *' : ''}<select name="${name}" ${readonly ? 'disabled' : ''}>
        <option value="approved" ${value === 'approved' ? 'selected' : ''}>已通过</option>
        <option value="pending" ${value === 'pending' ? 'selected' : ''}>待处理</option>
        <option value="rejected" ${value === 'rejected' ? 'selected' : ''}>未通过</option></select></label>`;
    if (type === 'textarea') return `<label class="wide">${label}${required ? ' *' : ''}<textarea name="${name}" ${required ? 'required' : ''} ${readonly ? 'readonly' : ''}>${escapeHtml(value)}</textarea></label>`;
    if (type === 'checkbox') return `<label>${label}<select name="${name}" ${readonly ? 'disabled' : ''}>
        <option value="false" ${!value ? 'selected' : ''}>否</option><option value="true" ${value ? 'selected' : ''}>是</option></select></label>`;
    return `<label>${label}${required ? ' *' : ''}<input name="${name}" type="${type}" value="${escapeHtml(value)}" ${required ? 'required' : ''} ${readonly ? 'readonly' : ''}></label>`;
}

function openStudentDialog(record = null, newLeave = false) {
    state.editing = newLeave ? null : record;
    state.creatingFor = newLeave ? record.studentId : null;
    const memberMode = state.session.role !== 'owner';
    $('#formTitle').textContent = newLeave ? `新增请假 · ${record.name}`
        : record ? (memberMode ? '修改本人内容' : `编辑 ${record.name}`) : '新增学生';
    const identity = fields.slice(0, 9), leave = fields.slice(9);
    $('#studentError').hidden = true;
    $('#saveStudentButton').textContent = record && !newLeave ? '保存修改' : '生成新链接';
    $('#studentFields').innerHTML = `<details class="editor-section" ${!record ? 'open' : ''}>
        <summary>学生信息<span>${record ? `${escapeHtml(record.name)} · ${escapeHtml(record.studentId)}` : '先填写学生档案'}</span></summary>
        <div class="form-grid">${identity.map(field => inputMarkup(field, record, memberMode, newLeave)).join('')}</div></details>
        <fieldset class="editor-section"><legend>本次请假</legend><div class="form-grid">${leave.map(field => inputMarkup(field, record, memberMode, newLeave)).join('')}</div></fieldset>
        ${attachmentEditorMarkup()}`;
    const items = !newLeave && Array.isArray(record?.attachments)
        ? record.attachments.map(item => ({ id: item.id, url: item.url })) : [];
    attachmentDrafts.set($('#studentForm'), { items, baseline: JSON.stringify(items.map(item => item.id)), processing: false });
    renderAttachmentDraft();
    trackForm($('#studentForm'));
    $('#studentDialog').showModal();
    $('#studentFields').querySelector(record ? '[name="leaveType"]' : '[name="name"]').focus();
}

async function saveStudent(event) {
    event.preventDefault();
    const button = $('#saveStudentButton');
    if (button.disabled) return;
    const editing = state.editing;
    const label = button.textContent;
    $('#studentError').hidden = true;
    try {
        const data = Object.fromEntries(new FormData(event.currentTarget));
        const attachments = attachmentDrafts.get(event.currentTarget);
        if (attachments && JSON.stringify(attachments.items.map(item => item.id || item.key)) !== attachments.baseline) {
            data.attachments = attachments.items.map(item => item.id ? { id: item.id } : { data: item.data });
        }
        data.needLeaveSchool = data.needLeaveSchool === 'true';
        if (!data.startAt || !data.endAt || new Date(data.endAt) <= new Date(data.startAt)) throw new Error('结束时间必须晚于开始时间。');
        data.startAt = new Date(data.startAt).toISOString();
        data.endAt = new Date(data.endAt).toISOString();
        if (!editing) data.createStudent = !state.creatingFor;
        button.disabled = true;
        button.textContent = '保存中…';
        setFormBusy(event.currentTarget, true);
        const response = await api(editing ? `students/${editing.shareId}` : 'students', {
            method: editing ? 'PUT' : 'POST', body: JSON.stringify(data)
        });
        state.revision++;
        if (!editing && state.session.role === 'member') {
            state.selfPage = 1;
            state.newOwnRecordId = response.record.shareId;
        }
        commitStudents(mergeRecordData(state, response.record));
        state.logsLoaded = false;
        $('#studentDialog').close();
        if (!editing && state.session.role === 'member') focusNewOwnRecord(response.record.shareId);
        if (!editing && state.session.role === 'owner') {
            state.historyStudentId = response.record.studentId;
            state.historyPage = 1;
            renderHistory();
            if (!$('#historyDialog').open) $('#historyDialog').showModal();
        }
        synced('已保存');
        showToast(editing ? '记录已更新，链接保持不变' : '请假记录已新增，链接已自动生成');
        // Reassignment can change retention order across two students; reconcile it.
        if (editing && editing.studentId !== response.record.studentId) loadStudents().catch(() => notice('保存已完成，请刷新确认学生归属。'));
    } catch (error) {
        $('#studentError').textContent = errorText(error);
        $('#studentError').hidden = false;
        showToast(`保存失败：${errorText(error)}`);
    } finally {
        setFormBusy($('#studentForm'), false);
        button.disabled = false;
        button.textContent = label;
    }
}

async function loadMembers(force = false) {
    if (state.session.role !== 'owner' || (state.membersLoaded && !force)) return;
    const revision = state.memberRevision;
    const data = await api('members');
    if (revision !== state.memberRevision) return;
    state.members = data.members;
    state.membersLoaded = true;
    renderMembers();
}

function renderMembers() {
    $('#memberCount').textContent = state.members.filter((member) => member.enabled).length;
    $('#memberCards').innerHTML = state.members.length ? state.members.map((member) => `
        <article class="member-card"><h3>${escapeHtml(member.displayName)}</h3>
            <p>${escapeHtml(member.email)}</p><p>绑定学号：${escapeHtml(member.studentId)}</p>
            <footer><span class="badge ${member.enabled ? '' : 'off'}">${member.enabled ? '可登录' : '登录已停用'}</span>
            <button class="row-action ${member.enabled ? 'danger' : ''}" type="button" data-member="${escapeHtml(member.email)}" data-enabled="${!member.enabled}" ${state.pending.has(`member:${member.email}`) ? 'disabled' : ''}>${member.enabled ? '停用登录' : '恢复登录'}</button></footer></article>`).join('')
        : '<div class="empty">尚未绑定成员账号</div>';
    renderMemberOptions();
}

function renderMemberOptions() {
    const bound = new Set(state.members.map((member) => member.studentId));
    $('#memberStudentSelect').innerHTML = state.students.filter((student) => !bound.has(student.studentId))
        .map((student) => `<option value="${escapeHtml(student.studentId)}">${escapeHtml(student.name)} · ${escapeHtml(student.studentId)}</option>`).join('');
    updateBindingReview();
}

function updateBindingReview() {
    const form = $('#memberForm');
    const email = form.elements.email.value.trim().toLowerCase();
    const student = state.students.find(student => student.studentId === form.elements.studentId.value);
    const review = $('#memberBindingReview');
    if (!email || !student) {
        review.textContent = '填写登录邮箱并选择学生后，可在此核对绑定关系。';
        review.removeAttribute('data-existing');
        return;
    }
    const member = state.members.find(member => member.email.toLowerCase() === email);
    const target = `${student.name}（${student.studentId}）`;
    let text = `本次绑定：${email} → ${target}。`;
    if (member) {
        const previous = state.students.find(student => student.studentId === member.studentId);
        text += `\n该邮箱当前绑定 ${previous ? `${previous.name}（${member.studentId}）` : member.studentId}，${member.enabled ? '可以登录' : '登录已停用'}。`;
        text += member.studentId === student.studentId ? '\n保存后绑定学号不变' : '\n保存后将改绑到上述学生';
        text += member.enabled ? '。' : '，并恢复登录权限。';
        review.setAttribute('data-existing', '');
    } else {
        text += '\n保存后，该邮箱可登录并管理所绑定学生的本人请假。';
        review.removeAttribute('data-existing');
    }
    review.textContent = text;
}

async function saveMember(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('#saveMemberButton');
    if (button.disabled) return;
    const data = Object.fromEntries(new FormData(form));
    button.disabled = true;
    button.textContent = '保存中…';
    setFormBusy(form, true);
    try {
        const response = await api('members', { method: 'POST', body: JSON.stringify(data) });
        state.revision++;
        state.members = [...state.members.filter(member => member.email !== response.member.email), response.member];
        state.memberRevision++;
        state.membersLoaded = true;
        state.logsLoaded = false;
        renderMembers();
        $('#memberDialog').close();
        form.reset();
        synced('已保存');
        showToast('成员账号已绑定');
    } catch (error) { showToast(`绑定失败：${errorText(error)}`); }
    finally { setFormBusy(form, false); button.disabled = false; button.textContent = '保存绑定'; }
}

async function loadAudit(force = false) {
    if (state.session.role !== 'owner' || (state.logsLoaded && !force)) return;
    state.logs = (await api('audit')).logs;
    state.logsLoaded = true;
    const labels = { create: '新增', update: '修改', disable: '停用', restore: '恢复', member_upsert: '绑定成员', member_disable: '切换成员权限' };
    $('#auditList').innerHTML = state.logs.length ? state.logs.map((log) => `
        <div class="log"><time>${fullTime(log.created_at)}</time>
            <strong>${escapeHtml(labels[log.action] || log.action)} · ${escapeHtml(log.student_name || log.student_id || '权限')}</strong>
            <span>${escapeHtml(log.actor_email)}</span></div>`).join('') : '<div class="empty">暂无操作记录</div>';
}

function showTab(name) {
    state.tab = name;
    $$('.tabs button').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
    ['students', 'members', 'audit'].forEach((tab) => $(`#${tab}Panel`).hidden = tab !== name);
    $('.breadcrumb strong').textContent = { students: '请假数据', members: '成员权限', audit: '操作记录' }[name];
    if (name === 'members' && !state.membersLoaded) $('#memberCards').innerHTML = '<div class="empty">正在读取成员…</div>';
    if (name === 'audit' && !state.logsLoaded) $('#auditList').innerHTML = '<div class="empty">正在读取操作记录…</div>';
}

async function switchTab(name) {
    if (!state.session || state.session.role !== 'owner') return;
    showTab(name);
    persistView();
    try {
        if (name === 'members') await loadMembers();
        if (name === 'audit') await loadAudit();
    } catch (error) { notice(errorText(error)); showToast(`读取失败：${errorText(error)}`); }
}

async function init() {
    if (state.initializing) return;
    state.initializing = true;
    $('#refreshButton').disabled = true;
    $('#studentsPanel').setAttribute('aria-busy', 'true');
    notice();
    try {
        // Each route checks access; only render the prefetched data after confirming the session.
        const revision = state.revision;
        const initialStudents = api('students').then(data => ({ data }), error => ({ error }));
        state.session = (await api('session')).user;
        applyRole();
        restoreView();
        if (state.session.role === 'owner') showTab(state.tab);
        const members = loadMembers().catch(error => notice(`成员信息暂未更新：${errorText(error)}`));
        const audit = state.tab === 'audit' ? loadAudit().catch(error => notice(errorText(error))) : Promise.resolve();
        const students = await initialStudents;
        if (students.error) throw students.error;
        if (revision === state.revision) commitStudents(students.data);
        synced();
        persistView();
        await Promise.all([members, audit]);
    } catch (error) {
        $('#syncStatus').textContent = '连接未完成';
        notice(errorText(error));
        showToast(`加载失败：${errorText(error)}`);
    } finally {
        state.initializing = false;
        $('#refreshButton').disabled = false;
        $('#studentsPanel').setAttribute('aria-busy', 'false');
    }
}

async function refreshPage() {
    if (state.refreshing || state.initializing) return;
    if (!state.ready) return init();
    state.refreshing = true;
    const button = $('#refreshButton');
    button.disabled = true;
    button.classList.add('is-pending');
    button.querySelector('span').textContent = '刷新中';
    try {
        await Promise.all([loadStudents(), loadMembers(true), !$('#auditPanel').hidden ? loadAudit(true) : Promise.resolve()]);
        notice(); synced(); showToast('数据已刷新');
    } catch (error) { notice(errorText(error)); showToast(`刷新未完成：${errorText(error)}`); }
    finally {
        state.refreshing = false;
        button.disabled = false;
        button.classList.remove('is-pending');
        button.querySelector('span').textContent = '刷新';
    }
}

function newLeave(studentId) {
    if (!state.ready) return;
    const memberMode = state.session.role === 'member';
    if (memberMode && studentId !== state.session.studentId) return;
    const student = state.students.find(item => item.studentId === studentId);
    const latest = state.index.byStudent.get(studentId)?.[0];
    if (memberMode && !latest) return showToast(errorText(new Error('LEAVE_TEMPLATE_NOT_FOUND')));
    if (student) openStudentDialog({ ...latest, ...student, ...(memberMode ? { status: 'approved' } : {}) }, true);
}

$('#addStudentButton').addEventListener('click', () => openStudentDialog());
$('#addOwnLeaveButton').addEventListener('click', () => newLeave(state.session.studentId));
$('#addLeaveButton').addEventListener('click', () => newLeave(state.historyStudentId));
$('#addMemberButton').addEventListener('click', async () => {
    try {
        await loadMembers();
        renderMemberOptions();
        if (!$('#memberStudentSelect').options.length) return showToast('所有学生已有绑定，请管理已有成员账号。');
        const form = $('#memberForm');
        form.reset();
        form.elements.displayName.value = state.students.find(student => student.studentId === form.elements.studentId.value)?.name || '';
        updateBindingReview();
        trackForm(form);
        $('#memberDialog').showModal();
        form.elements.email.focus();
    } catch (error) { showToast(errorText(error)); }
});
$('#searchInput').addEventListener('input', () => {
    state.studentPage = 1; renderStudents(); queueViewSave();
});
$('#sortSelect').addEventListener('change', event => {
    state.sort = event.target.value; state.studentPage = 1; renderStudents(); persistView();
});
$('#resetFiltersButton').addEventListener('click', () => {
    $('#searchInput').value = '';
    state.filter = 'all'; state.studentPage = 1;
    updateFilterButtons(); renderStudents(); persistView();
    $('#searchInput').focus({ preventScroll: true });
});
$('#memberStudentSelect').addEventListener('change', event => {
    $('#memberForm').elements.displayName.value = state.students.find(student => student.studentId === event.target.value)?.name || '';
    updateBindingReview();
});
$('#memberForm').elements.email.addEventListener('input', updateBindingReview);
$('#studentForm').addEventListener('submit', (event) => saveStudent(event).catch((error) => showToast(`保存失败：${error.message}`)));
$('#studentFields').addEventListener('change', event => {
    if (event.target.id === 'attachmentInput') addAttachments(event.target);
});
$('#studentFields').addEventListener('click', event => {
    const button = event.target.closest('[data-attachment-action]');
    if (!button || button.disabled || $('#saveStudentButton').disabled) return;
    if (button.dataset.attachmentAction === 'add') { $('#attachmentInput').click(); return; }
    const draft = attachmentDrafts.get($('#studentForm'));
    if (draft && button.dataset.attachmentAction === 'remove') {
        draft.items.splice(Number(button.dataset.attachmentIndex), 1);
        renderAttachmentDraft(); showAttachmentMessage('附件修改将在保存后生效。');
    }
});
$('#studentDialog').addEventListener('close', () => { attachmentDrafts.delete($('#studentForm')); });
$('#memberForm').addEventListener('submit', (event) => saveMember(event).catch((error) => showToast(`绑定失败：${error.message}`)));
function saving(dialog) {
    return (dialog.id === 'studentDialog' && $('#saveStudentButton').disabled)
        || (dialog.id === 'memberDialog' && $('#saveMemberButton').disabled);
}
$$('[data-close]').forEach(button => button.addEventListener('click', () => {
    requestClose(button.closest('dialog'));
}));
$$('dialog').forEach(dialog => dialog.addEventListener('cancel', event => {
    event.preventDefault();
    requestClose(dialog);
}));
$$('.tabs button').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
$('#refreshButton').addEventListener('click', refreshPage);
$('#retryButton').addEventListener('click', refreshPage);
$('#selectLinkButton').addEventListener('click', () => { $('#shareLink').focus(); $('#shareLink').select(); });
$('#copyShareButton').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#shareLink').value); showToast('分享链接已复制'); }
    catch { $('#shareLink').focus(); $('#shareLink').select(); showToast('请选中或长按链接复制'); }
});
document.addEventListener('keydown', event => {
    if (!state.ready || state.session.role !== 'owner' || $('dialog[open]')) return;
    const shortcut = (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey))
        || (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName));
    if (shortcut) { event.preventDefault(); switchTab('students'); $('#searchInput').focus(); }
});

document.addEventListener('click', async (event) => {
    if (!state.ready) return;
    const pageButton = event.target.closest('[data-page-target]');
    if (pageButton && !pageButton.disabled) {
        state[pageButton.dataset.pageTarget] = Number(pageButton.dataset.page);
        if (pageButton.dataset.pageTarget === 'historyPage') { renderHistory(); $('#historyRecords').scrollTop = 0; }
        else {
            renderStudents();
            $(pageButton.dataset.pageTarget === 'selfPage' ? '#selfEditor' : '#studentsPanel').scrollIntoView({ block: 'start' });
            persistView();
        }
        return;
    }
    const filterButton = event.target.closest('[data-filter]');
    if (filterButton) {
        state.filter = filterButton.dataset.filter; state.studentPage = 1;
        updateFilterButtons();
        renderStudents(); persistView(); return;
    }
    const newButton = event.target.closest('[data-new-leave]');
    if (newButton) { newLeave(newButton.dataset.newLeave); return; }
    const historyButton = event.target.closest('[data-history]');
    if (historyButton) {
        state.historyStudentId = historyButton.dataset.history;
        state.historyPage = 1;
        renderHistory();
        $('#historyDialog').showModal();
        return;
    }
    const editButton = event.target.closest('[data-edit]');
    if (editButton) {
        const record = state.index.byId.get(editButton.dataset.edit);
        if (record) openStudentDialog(record);
        return;
    }
    const copyButton = event.target.closest('[data-copy]');
    if (copyButton) {
        const record = state.index.byId.get(copyButton.dataset.copy);
        if (!record) return;
        const url = shareUrl(record);
        try { await navigator.clipboard.writeText(url); showToast('分享链接已复制'); }
        catch {
            openLinkDialog(record);
            $('#shareLink').focus(); $('#shareLink').select();
        }
        return;
    }
    const stateButton = event.target.closest('[data-state]');
    if (stateButton) {
        const id = stateButton.dataset.state;
        if (state.pending.has(id)) return;
        const action = stateButton.dataset.action;
        const record = state.index.byId.get(id);
        if (!record) return;
        if (!confirm(`确认${action === 'disable' ? '停用' : '恢复'} ${record.name} 的这条请假链接？\n${shortTime(record.startAt)} → ${shortTime(record.endAt)}\n只影响本条链接，不影响账号登录。`)) return;
        state.pending.add(id);
        renderStudents();
        if ($('#historyDialog').open) renderHistory();
        try {
            const response = await api(`students/${id}`, { method: 'PATCH', body: JSON.stringify({ action }) });
            state.revision++;
            commitStudents(mergeRecordData(state, { shareId: id, disabled: response.disabled }, { profile: false }));
            state.logsLoaded = false;
            synced('已保存');
            showToast(action === 'disable' ? '记录已停用' : '记录已恢复');
            try {
                const record = (await api(`students/${id}`)).record;
                commitStudents(mergeRecordData(state, record, { profile: false }));
            } catch { notice('状态已保存，更新时间暂未读取到；可点击刷新。'); }
        } catch (error) { showToast(`操作未完成：${errorText(error)}`); }
        finally {
            state.pending.delete(id); renderStudents();
            if ($('#historyDialog').open) renderHistory();
        }
        return;
    }
    const memberButton = event.target.closest('[data-member]');
    if (memberButton) {
        const email = memberButton.dataset.member, key = `member:${email}`;
        if (state.pending.has(key)) return;
        const enabled = memberButton.dataset.enabled === 'true';
        state.pending.add(key); renderMembers();
        try {
            await api('members', { method: 'PATCH', body: JSON.stringify({
                email, enabled
            }) });
            state.revision++;
            state.members = state.members.map(member => member.email === email ? { ...member, enabled } : member);
            state.memberRevision++;
            state.logsLoaded = false;
            synced('已保存');
            showToast(enabled ? '登录权限已恢复' : '登录权限已停用');
        } catch (error) { showToast(`操作未完成：${errorText(error)}`); }
        finally { state.pending.delete(key); renderMembers(); }
    }
});

init();
