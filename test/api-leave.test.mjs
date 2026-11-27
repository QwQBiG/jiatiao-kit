import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest, onRequestGet } from '../functions/api/leave/[id].js';

const VALID_ID = '0123456789abcdef0123456789abcdef';
const VALID_HASH = '3eb1bd439947eb762998e566ccc2e099c791118b2f40579cc4f7da2b5061b7f9';

const DEMO_ROW = {
    name: '演示同学',
    short_name: '演示',
    student_id: 'EXAMPLE-STUDENT-001',
    gender: '男',
    grade: '2026',
    college: '演示学院',
    major: '演示专业',
    class_name: '演示班',
    dorm: '-',
    leave_type: '事假（演示）',
    need_leave_school: 0,
    approver: '演示管理员',
    reason: '演示原因',
    destination: '演示校区',
    status: 'approved',
    start_at: '2026-08-31T00:00:00.000Z',
    end_at: '2026-08-31T14:00:00.000Z',
    created_at: '2026-08-31T00:00:00.000Z',
    expires_at: '2999-01-01T00:00:00.000Z'
};

function createContext({ id = VALID_ID, row = DEMO_ROW, queryError = null, withDb = true } = {}) {
    const context = { params: { id }, env: {} };
    if (!withDb) return context;
    context.env.DB = {
        prepare(sql) {
            assert.match(sql, /FROM leave_share_records/);
            return {
                bind(tokenHash) {
                    assert.equal(tokenHash, VALID_HASH);
                    return {
                        async first() {
                            if (queryError) throw queryError;
                            return row;
                        }
                    };
                }
            };
        }
    };
    return context;
}

test('valid id returns one sanitized demo record', async () => {
    const response = await onRequestGet(createContext());
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
    assert.equal(body.demo, true);
    assert.equal(body.record.name, '演示同学');
    assert.equal(body.record.approvalLabel, '已通过');
    assert.equal(JSON.stringify(body).includes(VALID_ID), false);
    assert.equal(JSON.stringify(body).includes(VALID_HASH), false);
});

test('invalid id is rejected before database access', async () => {
    const response = await onRequestGet(createContext({ id: 'not-a-valid-id', withDb: false }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'INVALID_ID' });
});

test('unknown id returns not found', async () => {
    const response = await onRequestGet(createContext({ row: null }));
    assert.equal(response.status, 404);
});

test('expired id returns gone', async () => {
    const response = await onRequestGet(createContext({
        row: { ...DEMO_ROW, expires_at: '2000-01-01T00:00:00.000Z' }
    }));
    assert.equal(response.status, 410);
});

test('missing binding and query failures return service unavailable', async () => {
    const missingBinding = await onRequestGet(createContext({ withDb: false }));
    assert.equal(missingBinding.status, 503);
    const queryFailure = await onRequestGet(createContext({ queryError: new Error('test failure') }));
    assert.equal(queryFailure.status, 503);
});

test('non-GET requests are rejected', async () => {
    const response = onRequest();
    assert.equal(response.status, 405);
});
