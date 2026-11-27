import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile('public/wec-counselor-leave-apps/leave/share/app.js', 'utf8');
const ID = '0123456789abcdef0123456789abcdef';
const BASE = Date.parse('2026-10-22T00:00:00.000Z');
const payload = { serverNow: new Date(BASE).toISOString(), record: {
    name: 'Demo', status: 'approved', approvalLabel: '已通过',
    startAt: new Date(BASE + 1000).toISOString(), endAt: new Date(BASE + 3000).toISOString(),
    ruleEnabledAt: new Date(BASE).toISOString()
} };

async function settle() { await nextTurn(); await nextTurn(); }

test('only an available approved record displays the approval mark', async () => {
    for (const status of ['approved', 'pending', 'rejected']) {
        const page = fixture({ readyState: 'interactive',
            fetchImpl: async () => Response.json({ ...payload, record: { ...payload.record, status } }) });
        await settle();
        assert.equal(page.element('approvalMark').hidden, status !== 'approved');
    }
    const unavailable = fixture({ readyState: 'interactive', fetchImpl: async () => new Response(null, { status: 410 }) });
    await settle();
    assert.equal(unavailable.element('approvalMark').hidden, true);
    assert.equal(unavailable.element('approvalStatus').textContent, '审批状态不可用');
});

function fixture({ id = ID, readyState = 'loading', fetchImpl = async () => Response.json(payload),
    initial = null, navigationStart = null, scriptAt = 0, navigationEntry = null, receivedAt = null, trackWork = false } = {}) {
    let elapsed = scriptAt;
    const work = {};
    const resetWork = () => Object.assign(work, { constructs: 0, formats: { seconds: 0, minutes: 0 },
        textWrites: {}, textValues: {}, classWrites: {}, stringDateParses: 0 });
    resetWork();
    const bootstrap = initial === null ? null : {
        textContent: typeof initial === 'string' ? initial : JSON.stringify(initial),
        removed: false, remove() { this.removed = true; }
    };
    const clock = receivedAt === null ? null : { removed: false,
        getAttribute: () => String(receivedAt), remove() { this.removed = true; } };
    const elements = new Map(), listeners = new Map(), intervals = [], requests = [], errors = [];
    const element = id => {
        if (!elements.has(id)) {
            let content = '';
            const classWrite = () => { work.classWrites[id] = (work.classWrites[id] || 0) + 1; };
            elements.set(id, { get textContent() { return content; }, set textContent(value) {
                content = value;
                work.textWrites[id] = (work.textWrites[id] || 0) + 1;
                (work.textValues[id] ||= []).push(value);
            }, style: {}, classList: { add: classWrite, remove: classWrite, toggle() {} }, addEventListener() {} });
        }
        return elements.get(id);
    };
    const document = {
        readyState,
        getElementById(id) {
            if (id === 'leaveBootstrap') return bootstrap;
            if (id === 'leaveResponseClock') return clock;
            assert.notEqual(document.readyState, 'loading', 'Do not access DOM before parsing finishes');
            return element(id);
        },
        querySelectorAll: () => [],
        addEventListener(type, callback) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(callback);
        },
        removeEventListener(type, callback) { listeners.get(type)?.delete(callback); }
    };
    class ClockDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : [BASE + elapsed]));
            if (typeof args[0] === 'string') work.stringDateParses++;
        }
        static now() { return BASE + elapsed; }
    }
    const measuredIntl = { DateTimeFormat: function (locale, options) {
        work.constructs++;
        const formatter = new Intl.DateTimeFormat(locale, options);
        const format = formatter.formatToParts.bind(formatter);
        formatter.formatToParts = date => {
            work.formats[options.second ? 'seconds' : 'minutes']++;
            return format(date);
        };
        return formatter;
    } };
    const context = vm.createContext({ document, Date: ClockDate, Intl: trackWork ? measuredIntl : Intl, URLSearchParams,
        performance: { now: () => elapsed,
            getEntriesByType: () => navigationEntry ? [navigationEntry] : navigationStart === null ? [] :
                [{ responseStart: navigationStart, finalResponseHeadersStart: navigationStart, firstInterimResponseStart: 0 }] },
        console: { error: (...args) => errors.push(args) },
        window: { location: { search: '?id=' + id, assign() {} }, setTimeout() {},
            setInterval(callback, duration) { intervals.push({ callback, duration }); return intervals.length; } },
        fetch(url, options) { requests.push({ url, options }); return fetchImpl(); }
    });
    vm.runInContext(source, context, { filename: 'share-app.js' });
    return { element, intervals, requests, errors, listeners, bootstrap, clock, work, resetWork,
        advance(ms) { elapsed += ms; },
        ready(state = 'interactive') {
            document.readyState = state;
            for (const callback of [...(listeners.get('readystatechange') || [])]) callback();
        }
    };
}

test('actual leave time appears only after completion and switches without a reload', async () => {
    const end = BASE + 14 * 60 * 60 * 1000;
    const record = { ...payload.record, startAt: new Date(BASE + 1000).toISOString(),
        endAt: new Date(end).toISOString() };
    const page = fixture({ readyState: 'interactive', trackWork: true,
        fetchImpl: async () => Response.json({ ...payload, record }) });
    await settle();
    assert.equal(page.element('statusText').textContent, '即将休假');
    assert.equal(page.element('actualLeaveTime').textContent, '-');
    for (const advance of [1000, end - BASE - 1000]) {
        page.advance(advance);
        page.intervals[0].callback();
        assert.equal(page.element('statusText').textContent, '正在休假中');
        assert.equal(page.element('actualLeaveTime').textContent, '-');
    }
    page.resetWork();
    page.advance(1000);
    page.intervals[0].callback();
    assert.equal(page.element('statusText').textContent, '已完成');
    assert.equal(page.element('actualLeaveTime').textContent,
        '10-22 08:00 ~ 10-22 22:00（共13小时59分钟）');
    assert.deepEqual(page.work.textValues.actualLeaveTime, [page.element('actualLeaveTime').textContent]);
    assert.equal(page.work.formats.minutes, 2);
    assert.equal(page.requests.length, 1);
    for (const status of ['pending', 'rejected']) {
        const incomplete = fixture({ readyState: 'interactive',
            fetchImpl: async () => Response.json({ ...payload, serverNow: new Date(end + 1000).toISOString(),
                record: { ...record, status } }) });
        await settle();
        assert.equal(incomplete.element('actualLeaveTime').textContent, '-');
    }
});

test('stable leave phases reuse formatters and dates while writing only the ticking clock', async () => {
    for (const phase of ['active', 'completed', 'pending', 'rejected']) {
        const record = { ...payload.record, status: ['pending', 'rejected'].includes(phase) ? phase : 'approved',
            startAt: new Date(BASE - 3600000).toISOString(),
            endAt: new Date(phase === 'active' ? BASE + 86400000 : BASE - 1).toISOString() };
        const page = fixture({ readyState: 'interactive', trackWork: true,
            fetchImpl: async () => Response.json({ ...payload, record }) });
        await settle();
        assert.equal(page.work.constructs, 2);
        page.resetWork();
        for (let index = 0; index < 10; index++) {
            page.advance(1000);
            page.intervals[0].callback();
        }
        assert.equal(page.work.constructs, 0);
        assert.deepEqual(page.work.formats, { seconds: 10, minutes: 0 });
        assert.equal(page.work.stringDateParses, 0);
        assert.deepEqual(page.work.textWrites, { liveTime: 10 });
        assert.deepEqual(page.work.classWrites, {});
        assert.deepEqual(page.errors, []);
    }
});

test('early data ages while waiting for DOM without shifting the clock or leave boundaries', async () => {
    const page = fixture();
    await settle();
    assert.equal(page.requests.length, 1);
    assert.equal(page.requests[0].url, '/api/leave/' + ID);
    assert.equal(page.requests[0].options.headers.Accept, 'application/json');
    assert.equal(page.requests[0].options.cache, 'no-store');
    assert.equal(page.requests[0].options.credentials, 'same-origin');
    assert.equal(page.intervals.length, 0);
    page.advance(2000);
    page.ready();
    await settle();
    assert.equal(page.element('liveTime').textContent, '2026-10-22 08:00:02');
    assert.equal(page.element('statusText').textContent, '正在休假中');
    page.advance(2000);
    page.intervals[0].callback();
    assert.equal(page.element('liveTime').textContent, '2026-10-22 08:00:04');
    assert.equal(page.element('statusText').textContent, '已完成');
    assert.equal(page.requests.length, 1);
});

test('interactive starts rendering without a DOMContentLoaded event from unrelated deferred scripts', async () => {
    const page = fixture();
    await settle();
    page.ready('interactive');
    await settle();
    assert.equal(page.element('userName').textContent, 'Demo');
    assert.equal(page.element('initialLoadingToast').style.display, 'none');
    assert.equal(page.listeners.get('DOMContentLoaded')?.size || 0, 0);
    assert.equal(page.listeners.get('readystatechange').size, 0);
    assert.equal(page.intervals.length, 1);
    assert.equal(page.intervals[0].duration, 1000);
    page.ready('complete');
    assert.equal(page.intervals.length, 1);
});

test('a script arriving after parsing initializes exactly once', async () => {
    for (const readyState of ['interactive', 'complete']) {
        const page = fixture({ readyState });
        await settle();
        assert.equal(page.element('userName').textContent, 'Demo');
        assert.equal(page.requests.length, 1);
        assert.equal(page.intervals.length, 1);
        page.ready('complete');
        assert.equal(page.intervals.length, 1);
        assert.equal(page.listeners.get('readystatechange').size, 0);
    }
});

test('invalid IDs finish loading without requesting data', async () => {
    const page = fixture({ id: 'invalid' });
    await settle();
    page.ready();
    await settle();
    assert.equal(page.requests.length, 0);
    assert.equal(page.element('statusText').textContent, '链接格式无效');
    assert.equal(page.element('initialLoadingToast').style.display, 'none');
});

test('early HTTP, network and JSON failures settle before DOM without unhandled rejection', async t => {
    const unhandled = [];
    const onUnhandled = error => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.removeListener('unhandledRejection', onUnhandled));
    const cases = [
        [async () => { throw Error('network failed'); }, '暂时无法加载'],
        [async () => new Response('', { status: 404 }), '链接无效或已过期'],
        [async () => new Response('', { status: 410 }), '链接无效或已过期'],
        [async () => new Response('', { status: 503 }), '暂时无法加载'],
        [async () => new Response('invalid JSON'), '暂时无法加载']
    ];
    for (const [fetchImpl, message] of cases) {
        const page = fixture({ fetchImpl });
        await settle();
        assert.equal(page.intervals.length, 0);
        page.ready();
        await settle();
        assert.equal(page.requests.length, 1);
        assert.equal(page.element('statusText').textContent, message);
        assert.equal(page.element('initialLoadingToast').style.display, 'none');
        assert.equal(page.element('userName').textContent, '-');
    }
    assert.deepEqual(unhandled, []);
});

test('DOM readiness keeps loading until the single pending API request finishes', async () => {
    let resolveResponse;
    const response = new Promise(resolve => { resolveResponse = resolve; });
    const page = fixture({ fetchImpl: () => response });
    page.ready();
    await settle();
    assert.equal(page.element('initialLoadingToast').style.display, 'flex');
    assert.equal(page.element('userName').textContent, '');
    resolveResponse(Response.json(payload));
    await settle();
    assert.equal(page.element('userName').textContent, 'Demo');
    assert.equal(page.element('initialLoadingToast').style.display, 'none');
    assert.equal(page.requests.length, 1);
    assert.equal(page.intervals.length, 1);
});

test('HTML data compensates transfer, script and DOM waits without another API request', async () => {
    const page = fixture({ initial: { id: ID, status: 200, payload }, navigationStart: 10, scriptAt: 2010 });
    await settle();
    assert.equal(page.requests.length, 0);
    assert.equal(page.bootstrap.removed, true);
    page.advance(2000);
    page.ready();
    await settle();
    assert.equal(page.element('liveTime').textContent, '2026-10-22 08:00:04');
    assert.equal(page.element('statusText').textContent, '已完成');
    assert.equal(page.element('initialLoadingToast').style.display, 'none');
    assert.equal(page.requests.length, 0);
});

test('HTML error results preserve messages without retrying the same database read', async () => {
    for (const status of [404, 410, 503]) {
        const page = fixture({ initial: { id: ID, status, payload: { error: 'demo' } } });
        page.ready();
        await settle();
        assert.equal(page.requests.length, 0);
        assert.equal(page.element('statusText').textContent, status === 503 ? '暂时无法加载' : '链接无效或已过期');
        assert.equal(page.element('initialLoadingToast').style.display, 'none');
    }
});

test('HTML clock starts at the final response instead of an earlier 103 response', async () => {
    const page = fixture({ initial: { id: ID, status: 200, payload }, scriptAt: 3010, receivedAt: 1110,
        navigationEntry: { responseStart: 10, firstInterimResponseStart: 10, finalResponseHeadersStart: 1010 } });
    page.ready();
    await settle();
    assert.equal(page.requests.length, 0);
    assert.equal(page.clock.removed, true);
    assert.equal(page.element('liveTime').textContent, '2026-10-22 08:00:02');
    assert.equal(page.element('statusText').textContent, '正在休假中');
});

test('the early document clock preserves HTML data on browsers without final-response timing', async () => {
    for (const navigationEntry of [null, { responseStart: 10 },
        { responseStart: 5, firstInterimResponseStart: 5 }]) {
        const page = fixture({ initial: { id: ID, status: 200, payload }, receivedAt: 10,
            scriptAt: 2010, navigationEntry });
        await settle();
        assert.equal(page.requests.length, 0);
        assert.equal(page.clock.removed, true);
        assert.equal(page.bootstrap.removed, true);
        page.advance(2000);
        page.ready();
        await settle();
        assert.equal(page.element('liveTime').textContent, '2026-10-22 08:00:04');
        assert.equal(page.element('statusText').textContent, '已完成');
        assert.equal(page.element('initialLoadingToast').style.display, 'none');
        assert.equal(page.requests.length, 0);
    }
});

test('a rounded zero document clock is usable while invalid or future stamps retain API fallback', async () => {
    for (const receivedAt of [0, '', ' ', 'NaN', -1, 500]) {
        const page = fixture({ initial: { id: ID, status: 200, payload }, receivedAt, scriptAt: 20,
            navigationEntry: { responseStart: 10 } });
        page.ready();
        await settle();
        assert.equal(page.requests.length, receivedAt === 0 ? 0 : 1);
        assert.equal(page.element('userName').textContent, 'Demo');
        assert.equal(page.element('initialLoadingToast').style.display, 'none');
        assert.equal(page.errors.length, 0);
    }
});

test('missing or invalid HTML data or clock anchor falls back to the current API', async () => {
    for (const options of [
        { initial: 'invalid JSON' },
        { initial: { id: 'other', status: 200, payload } },
        { initial: { id: ID, status: 200, payload } },
        { initial: { id: ID, status: 200, payload }, navigationStart: 500 },
        { initial: { id: ID, status: 200, payload }, scriptAt: 20, navigationEntry: { responseStart: 10 } },
        { initial: { id: ID, status: 200, payload: {} }, navigationStart: 10, scriptAt: 20 }
    ]) {
        const page = fixture(options);
        page.ready();
        await settle();
        assert.equal(page.requests.length, 1);
        assert.equal(page.element('userName').textContent, 'Demo');
        assert.equal(page.element('initialLoadingToast').style.display, 'none');
    }
});
