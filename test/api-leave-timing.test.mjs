import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { onRequest, onRequestGet } from '../functions/api/leave/[id].js';

const ID = '0123456789abcdef0123456789abcdef';
const HASH = '3eb1bd439947eb762998e566ccc2e099c791118b2f40579cc4f7da2b5061b7f9';
const ROW = { name: 'Demo', student_id: 'DEMO', status: 'approved',
    reason: 'Before update', start_at: '2026-01-01T00:00:00Z',
    end_at: '2026-01-02T00:00:00Z', expires_at: null, revoked_at: null };

function createContext(state) {
    return { params: { id: ID }, env: { DB: {
        prepare(sql) {
            state.queries = (state.queries || 0) + 1;
            assert.match(sql, /WHERE token_hash = \?1 AND revoked_at IS NULL/);
            return { bind(hash) {
                assert.equal(hash, HASH);
                return { async first() {
                    if (state.delayMs) await delay(state.delayMs);
                    if (state.error) throw state.error;
                    return state.row && !state.row.revoked_at ? { ...state.row } : null;
                } };
            } };
        }
    } } };
}

function metrics(response) {
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
    const header = response.headers.get('Server-Timing');
    assert.ok(header);
    assert.equal(header.includes(ID) || header.includes(HASH), false);
    const result = {};
    for (const part of header.split(', ')) {
        const match = /^(total|hash|db);dur=(\d+\.\d{2})$/.exec(part);
        assert.ok(match, part);
        assert.equal(Object.hasOwn(result, match[1]), false);
        result[match[1]] = Number(match[2]);
    }
    assert.ok(result.total >= 0);
    return result;
}

test('database timing includes the controlled query wait', async () => {
    const state = { row: ROW, delayMs: 40 };
    const startedAt = performance.now();
    const response = await onRequestGet(createContext(state));
    const elapsed = performance.now() - startedAt;
    assert.equal(response.status, 200);
    const timing = metrics(response);
    assert.ok(timing.hash >= 0);
    assert.ok(timing.db >= 30, JSON.stringify(timing));
    assert.ok(timing.total + 0.02 >= timing.hash + timing.db);
    assert.ok(timing.total <= elapsed + 1);
    assert.equal(state.queries, 1);
    assert.equal((await response.json()).record.reason, ROW.reason);
});

test('failed database waits are included in timing', async t => {
    t.mock.method(console, 'error', () => {});
    const state = { row: ROW, delayMs: 40, error: new Error('controlled failure') };
    const response = await onRequestGet(createContext(state));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'SERVICE_UNAVAILABLE' });
    const timing = metrics(response);
    assert.ok(timing.hash >= 0);
    assert.ok(timing.db >= 30, JSON.stringify(timing));
    assert.ok(timing.total + 0.02 >= timing.hash + timing.db);
    assert.equal(state.queries, 1);
});

test('invalid IDs do not access the database or report unexecuted stages', async () => {
    const context = { params: { id: 'invalid' }, env: {
        get DB() { assert.fail('Invalid IDs must not access DB'); }
    } };
    const response = await onRequestGet(context);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'INVALID_ID' });
    assert.deepEqual(Object.keys(metrics(response)), ['total']);
});

test('missing bindings and unsupported methods only report total timing', async () => {
    const responses = [await onRequestGet({ params: { id: ID }, env: {} }), onRequest()];
    for (const [index, response] of responses.entries()) {
        assert.equal(response.status, index === 0 ? 503 : 405);
        assert.deepEqual(Object.keys(metrics(response)), ['total']);
    }
});

test('missing and expired records retain status and query timing', async () => {
    for (const [row, status] of [[null, 404], [{ ...ROW, expires_at: '2000-01-01T00:00:00Z' }, 410]]) {
        const state = { row };
        const response = await onRequestGet(createContext(state));
        assert.equal(response.status, status);
        assert.deepEqual(Object.keys(metrics(response)), ['total', 'hash', 'db']);
        assert.equal(state.queries, 1);
    }
});

test('updates and revocation are read again without retaining stale data', async () => {
    const state = { row: { ...ROW } };
    const context = createContext(state);
    const before = await onRequestGet(context);
    assert.equal((await before.json()).record.reason, 'Before update');
    metrics(before);
    state.row.reason = 'After update';
    const after = await onRequestGet(context);
    assert.equal((await after.json()).record.reason, 'After update');
    metrics(after);
    state.row.revoked_at = '2026-01-01T00:00:00Z';
    const revoked = await onRequestGet(context);
    assert.equal(revoked.status, 404);
    assert.deepEqual(await revoked.json(), { error: 'NOT_FOUND' });
    metrics(revoked);
    assert.equal(state.queries, 3);
});
