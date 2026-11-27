(function () {
    'use strict';

    var ID_PATTERN = /^[0-9a-f]{32}$/i;
    var TIME_ZONE = 'Asia/Shanghai';
    var dateFormatters = {};
    var pageState = {
        record: null,
        statusView: null,
        serverOffsetMs: 0,
        timerId: null
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function setText(id, value) {
        var element = byId(id);
        var nextText = value == null || value === '' ? '-' : String(value);
        if (element && element.textContent !== nextText) element.textContent = nextText;
    }

    function setRawText(id, value) {
        var element = byId(id);
        if (element) element.textContent = value == null ? '' : String(value);
    }

    function setLoading(loading) {
        var app = byId('app');
        var loadingToast = byId('initialLoadingToast');
        if (app) app.classList.toggle('is-loading', loading);
        if (loadingToast) loadingToast.style.display = loading ? 'flex' : 'none';
    }

    function getDateParts(date, includeSeconds) {
        var key = includeSeconds ? 'seconds' : 'minutes';
        var formatter = dateFormatters[key];
        if (!formatter) {
            var options = {
                timeZone: TIME_ZONE,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23'
            };
            if (includeSeconds) options.second = '2-digit';
            formatter = dateFormatters[key] = new Intl.DateTimeFormat('zh-CN', options);
        }
        var parts = formatter.formatToParts(date);
        return parts.reduce(function (result, part) {
            if (part.type !== 'literal') result[part.type] = part.value;
            return result;
        }, {});
    }

    function formatFullDate(date, includeSeconds) {
        var parts = getDateParts(date, includeSeconds);
        var value = parts.year + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute;
        return includeSeconds ? value + ':' + parts.second : value;
    }

    function formatShortDate(date) {
        var parts = getDateParts(date, false);
        return parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute;
    }

    function formatDuration(startDate, endDate) {
        var totalMinutes = Math.max(0, Math.floor((endDate - startDate) / 60000));
        var days = Math.floor(totalMinutes / 1440);
        var hours = Math.floor((totalMinutes % 1440) / 60);
        var minutes = totalMinutes % 60;
        var result = '';
        if (days) result += days + '天';
        if (hours) result += hours + '小时';
        if (minutes || !result) result += minutes + '分钟';
        return result;
    }

    function setFlag(flagClass, text) {
        var statusFlag = byId('statusFlag');
        if (statusFlag) {
            statusFlag.classList.remove('flag-success', 'flag-warning', 'flag-grey');
            statusFlag.classList.add(flagClass);
        }
        setText('statusText', text);
    }

    function serverNow() {
        return new Date(Date.now() + pageState.serverOffsetMs);
    }

    function updateStatus(now) {
        if (!pageState.record) return;
        var record = pageState.record;
        var view = pageState.statusView;
        var phase = record.status === 'pending' ? 'pending' : record.status === 'rejected' ? 'rejected' :
            now < view.startDate ? 'before' : now <= view.endDate ? 'active' : 'completed';
        if (view.phase === phase) return;
        view.phase = phase;

        var actualLeaveTime = '-';
        if (phase === 'pending' || phase === 'before') {
            setFlag('flag-warning', '即将休假');
        } else if (phase === 'rejected') {
            setFlag('flag-grey', '即将休假');
        } else if (phase === 'active') {
            setFlag('flag-success', '正在休假中');
        } else {
            setFlag('flag-grey', '已完成');
            actualLeaveTime = formatShortDate(view.startDate) + ' ~ ' + formatShortDate(view.endDate) +
                '（共' + formatDuration(view.startDate, view.endDate) + '）';
        }
        setText('actualLeaveTime', actualLeaveTime);
    }

    function updateClock() {
        var now = serverNow();
        setText('liveTime', formatFullDate(now, true));
        updateStatus(now);
    }

    function renderAttachments(attachments) {
        var container = byId('leaveAttachments');
        if (!container) return;
        container.textContent = '';
        if (!Array.isArray(attachments) || !attachments.length) return;
        var shareId = new URLSearchParams(window.location.search).get('id') || '';
        if (!ID_PATTERN.test(shareId)) return;
        var valid = attachments.filter(function (attachment) {
            return attachment && typeof attachment.id === 'string' && ID_PATTERN.test(attachment.id) &&
                Number.isInteger(attachment.width) && attachment.width >= 1 && attachment.width <= 192 &&
                Number.isInteger(attachment.height) && attachment.height >= 1 && attachment.height <= 192 &&
                attachment.url === '/api/leave/' + shareId.toLowerCase() + '/attachments/' + attachment.id.toLowerCase();
        }).slice(0, 3);
        if (!valid.length) return;

        var row = document.createElement('div');
        row.className = 'flex mb-5 font-12 items-start';
        var label = document.createElement('div');
        label.className = 'font-light no-shrink row-label';
        label.textContent = '附件：';
        var list = document.createElement('div');
        list.className = 'leave-attachment-list flex-1';
        row.appendChild(label);
        row.appendChild(list);
        valid.forEach(function (attachment) {
            var thumbnail = document.createElement('span');
            thumbnail.className = 'leave-attachment-thumb';
            var image = document.createElement('img');
            image.alt = '附件图片';
            image.width = attachment.width;
            image.height = attachment.height;
            image.loading = 'lazy';
            image.decoding = 'async';
            image.fetchPriority = 'low';
            image.addEventListener('error', function () {
                thumbnail.textContent = '图片加载失败';
                thumbnail.classList.add('is-error');
            });
            thumbnail.appendChild(image);
            list.appendChild(thumbnail);
            image.src = attachment.url;
        });
        // Native image loading stays independent of record readiness and the page loader.
        container.appendChild(row);
    }

    function showApproval(label, approved) {
        setText('approvalStatus', label);
        var mark = byId('approvalMark');
        if (mark) mark.hidden = !approved;
    }

    function renderRecord(payload, readyAt) {
        var record = payload.record;
        var startDate = new Date(record.startAt);
        var endDate = new Date(record.endAt);
        if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
            throw new Error('Invalid record time range');
        }

        pageState.record = record;
        pageState.statusView = { startDate: startDate, endDate: endDate, phase: null };
        // Preserve time spent waiting for the document after the response was read.
        pageState.serverOffsetMs = Date.parse(payload.serverNow) + (performance.now() - readyAt) - Date.now();
        showApproval('审批' + record.approvalLabel, record.status === 'approved');
        setText('userShortName', record.shortName || record.name.slice(-2));
        setText('userName', record.name);
        setText('userInfo', record.gender + '生' + record.studentId);
        setText('modalUserName', record.name);
        setText('modalUserId', record.studentId);
        setText('modalGender', record.gender);
        setText('modalGrade', record.grade);
        setText('modalCollege', record.college);
        setText('modalMajor', record.major);
        setText('modalClassName', record.className);
        setText('modalDorm', record.dorm || '-');
        setText('leaveType', record.leaveType);
        setText('needLeaveSchool', record.needLeaveSchool ? '是' : '否');
        setText('approver', record.approver);
        setText('reason', record.reason);
        setText('location', record.destination);
        setText('startTime', formatShortDate(startDate));
        setText('endTime', formatShortDate(endDate));
        setText('totalDays', formatDuration(startDate, endDate));
        var ruleDate = new Date(record.ruleEnabledAt);
        setText('ruleEnabledAt', record.ruleEnabledAt && Number.isFinite(ruleDate.getTime())
            ? formatFullDate(ruleDate, false) : '-');
        setText('ruleOperator', record.ruleOperator || '-');
        renderAttachments(record.attachments);
        updateClock();
    }

    function clearRecordFields(value) {
        renderAttachments(null);
        [
            'userShortName', 'userName', 'userInfo', 'modalUserName', 'modalUserId',
            'modalGender', 'modalGrade', 'modalCollege', 'modalMajor', 'modalClassName',
            'modalDorm', 'leaveType', 'needLeaveSchool', 'approver', 'reason', 'location',
            'startTime', 'endTime', 'totalDays', 'actualLeaveTime', 'ruleEnabledAt', 'ruleOperator'
        ].forEach(function (id) {
            setRawText(id, value);
        });
    }

    function renderError(message) {
        pageState.record = null;
        pageState.statusView = null;
        pageState.serverOffsetMs = 0;
        clearRecordFields('-');
        showApproval('审批状态不可用', false);
        setFlag('flag-grey', message);
        updateClock();
    }

    function initialRecord(id) {
        var element = byId('leaveBootstrap');
        if (!element) return null;
        try {
            var initial = JSON.parse(element.textContent);
            if (initial.id !== id.toLowerCase()) return null;
            if ([400, 404, 410, 503].includes(initial.status)) {
                element.remove();
                return { message: initial.status === 404 || initial.status === 410 ? '链接无效或已过期' : '暂时无法加载' };
            }
            if (initial.status !== 200 || !initial.payload || !initial.payload.record ||
                !Number.isFinite(Date.parse(initial.payload.serverNow))) return null;
            var navigation = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
            var readyAt = navigation && (navigation.finalResponseHeadersStart ||
                (navigation.firstInterimResponseStart === 0 ? navigation.responseStart : 0));
            var clock = byId('leaveResponseClock');
            if (!(readyAt > 0) || readyAt > performance.now()) {
                var stamp = clock && clock.getAttribute('data-received-at');
                readyAt = stamp == null || stamp.trim() === '' ? NaN : Number(stamp);
                if (!Number.isFinite(readyAt) || readyAt < 0 || readyAt > performance.now()) return null;
            }
            if (clock) clock.remove();
            element.remove();
            // Both anchors follow the final response, so earlier 103 hints cannot advance the clock.
            return { payload: initial.payload, readyAt: readyAt };
        } catch (error) {
            return null;
        }
    }

    async function requestRecord() {
        try {
            var id = new URLSearchParams(window.location.search).get('id') || '';
            if (!ID_PATTERN.test(id)) {
                return { message: '链接格式无效' };
            }
            var initial = initialRecord(id);
            if (initial) return initial;
            var response = await fetch('/api/leave/' + id.toLowerCase(), {
                method: 'GET',
                headers: { Accept: 'application/json' },
                cache: 'no-store',
                credentials: 'same-origin'
            });
            if (!response.ok) {
                return { message: response.status === 404 || response.status === 410 ? '链接无效或已过期' : '暂时无法加载' };
            }
            var payload = await response.json();
            return { payload: payload, readyAt: performance.now() };
        } catch (error) {
            console.error('Failed to load demo record:', error);
            return { message: '暂时无法加载' };
        }
    }

    async function loadRecord() {
        try {
            var result = await recordRequest;
            if (result.message) {
                renderError(result.message);
                return;
            }
            renderRecord(result.payload, result.readyAt);
        } catch (error) {
            console.error('Failed to load demo record:', error);
            renderError('暂时无法加载');
        } finally {
            setLoading(false);
        }
    }

    function showModal(modal) {
        if (!modal) return;
        modal.style.display = 'flex';
        modal.style.opacity = '0';
        window.setTimeout(function () {
            modal.style.opacity = '1';
        }, 10);
    }

    function hideModal(modal) {
        if (!modal) return;
        modal.style.opacity = '0';
        window.setTimeout(function () {
            modal.style.display = 'none';
        }, 300);
    }

    function bindModal(openButtonId, modalId, closeButtonId) {
        var modal = byId(modalId);
        var openButton = byId(openButtonId);
        var closeButton = byId(closeButtonId);
        if (modal) {
            modal.style.transition = 'opacity 0.3s ease';
            modal.style.opacity = '0';
            modal.addEventListener('click', function (event) {
                if (event.target === modal) hideModal(modal);
            });
        }
        if (openButton) {
            openButton.addEventListener('click', function (event) {
                event.stopPropagation();
                showModal(modal);
            });
        }
        if (closeButton) closeButton.addEventListener('click', function () { hideModal(modal); });
    }

    function showLoadingBriefly() {
        var loadingToast = byId('loadingToast');
        if (!loadingToast) return;
        loadingToast.style.display = 'flex';
        window.setTimeout(function () {
            loadingToast.style.display = 'none';
        }, 800);
    }

    function bindStaticInteractions() {
        bindModal('personalInfoBtn', 'personalModal', 'closeModalBtn');
        bindModal('viewRuleBtn', 'ruleModal', 'closeRuleBtn');
        document.querySelectorAll('.location').forEach(function (element) {
            element.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                showLoadingBriefly();
            });
        });
    }

    function init() {
        bindStaticInteractions();
        clearRecordFields('');
        setLoading(true);
        updateClock();
        pageState.timerId = window.setInterval(updateClock, 1000);
        loadRecord();
    }

    function startWhenParsed() {
        if (document.readyState === 'loading') return;
        document.removeEventListener('readystatechange', startWhenParsed);
        init();
    }

    // Neither data fetching nor rendering waits for unrelated deferred scripts.
    var recordRequest = requestRecord();
    document.addEventListener('readystatechange', startWhenParsed);
    startWhenParsed();
}());
