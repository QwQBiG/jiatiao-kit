import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequestGet as list, onRequestPost as create } from '../functions/admin/api/students.js';
import { onRequestGet as detail, onRequestPut as update, onRequestPatch as toggle } from '../functions/admin/api/students/[id].js';
import { onRequestGet as share } from '../functions/api/leave/[id].js';
import { onRequestGet as members, onRequestPost as bindMember, onRequestPatch as setMemberState } from '../functions/admin/api/members.js';
import { onRequestGet as audit } from '../functions/admin/api/audit.js';
import { fixture, owner, member, recordInput } from './helpers/database.mjs';

test('owner records keep the existing DTO, independent snapshots and live share state', async t => {
    const { db, DB, trace, context, add } = await fixture(t);
    const first = await add(), latest = await add({ ...recordInput, reason: '第二次示例' });
    await add({ ...recordInput, studentId: 'EXAMPLE-002' });
    assert.match(first.shareId, /^[0-9a-f]{32}$/);
    assert.notEqual(first.shareId, latest.shareId);
    const batches = trace.batches.length;
    const listing = await list(context(null, null, owner, 'GET'));
    const body = await listing.json();
    assert.equal(trace.batches.length, batches + 1);
    assert.equal(trace.batches.at(-1).length, 2);
    assert.equal(body.records.length, 3);
    assert.equal(body.students.length, 2);
    assert.equal(body.students[0].recordCount, 2);
    assert.deepEqual(Object.keys(body.records[0]).sort(), ['shareId','name','shortName','studentId','gender','grade',
        'college','major','className','dorm','leaveType','needLeaveSchool','approver','reason','destination','status',
        'startAt','endAt','attachments','disabled','createdAt','updatedAt'].sort());
    assert.match(listing.headers.get('Cache-Control'), /private, no-store/);
    assert.equal((await update(context({ reason: '已更新示例' }, first.shareId, owner, 'PUT'))).status, 200);
    assert.equal((await (await detail(context(null, latest.shareId))).json()).record.reason, '第二次示例');
    const shared = await (await share({ env: { DB }, params: { id: first.shareId } })).json();
    assert.equal(shared.demo, true);
    assert.ok(Number.isFinite(Date.parse(shared.serverNow)));
    assert.equal(shared.record.reason, '已更新示例');
    assert.equal(shared.record.ruleOperator, '演示管理员');
    assert.equal(shared.record.ruleEnabledAt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(shared.record.attachments, []);
    assert.equal(Object.hasOwn(shared.record, 'token_hash'), false);
    assert.equal((await toggle(context({ action: 'disable' }, first.shareId, owner, 'PATCH'))).status, 200);
    assert.equal((await share({ env: { DB }, params: { id: first.shareId } })).status, 404);
    assert.equal((await toggle(context({ action: 'restore' }, first.shareId, owner, 'PATCH'))).status, 200);
    assert.equal((await share({ env: { DB }, params: { id: first.shareId } })).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leave_share_records').get().n, 3);
});

test('member creation and editing retain server-owned identity and cannot cross student scope', async t => {
    const { db, trace, context, add } = await fixture(t);
    const original = await add(), other = await add({ ...recordInput, studentId: 'EXAMPLE-002' });
    db.prepare('UPDATE students SET name=?,class_name=? WHERE student_id=?').run('当前示例姓名', '当前示例班级', member.studentId);
    trace.reads.length = 0;
    const response = await create(context({ name: '不可覆盖', status: 'rejected', approver: '不可覆盖', reason: '成员示例' }, null, member));
    assert.equal(response.status, 201);
    assert.equal(trace.reads.length, 1);
    const record = (await response.json()).record;
    assert.notEqual(record.shareId, original.shareId);
    assert.equal(record.name, '当前示例姓名');
    assert.equal(record.className, '当前示例班级');
    assert.equal(record.approver, recordInput.approver);
    assert.equal(record.status, 'approved');
    assert.equal((await update(context({ name: '不可覆盖', reason: '成员已更新' }, record.shareId, member, 'PUT'))).status, 200);
    assert.equal((await detail(context(null, other.shareId, member))).status, 403);
    assert.equal((await update(context({ reason: '越界' }, other.shareId, member, 'PUT'))).status, 403);
    assert.equal((await toggle(context({ action: 'disable' }, record.shareId, member, 'PATCH'))).status, 403);
    assert.equal((await create(context({ studentId: 'EXAMPLE-002' }, null, member))).status, 403);
    assert.equal((await create(context({ createStudent: true }, null, member))).status, 403);
    const own = await (await list(context(null, null, member, 'GET'))).json();
    assert.equal(own.students.length, 1);
    assert.equal(own.records.length, 2);
    assert.ok(own.records.every(row => row.studentId === member.studentId));
    db.prepare('DELETE FROM leave_share_records WHERE student_id=?').run('EXAMPLE-002');
    const noTemplate = await create(context({}, null, { ...member, studentId: 'EXAMPLE-002' }));
    assert.equal(noTemplate.status, 409);
    assert.deepEqual(await noTemplate.json(), { error: 'LEAVE_TEMPLATE_NOT_FOUND' });
    assert.equal((await create(context({}, null, { ...member, studentId: 'MISSING' }))).status, 404);
});

test('membership and audit endpoints remain owner-only and changes are audited atomically', async t => {
    const { db, context, add } = await fixture(t);
    await add();
    assert.equal((await members(context(null, null, member, 'GET'))).status, 403);
    assert.equal((await audit(context(null, null, member, 'GET'))).status, 403);
    assert.equal((await bindMember(context({ email: member.email, displayName: '示例成员', studentId: member.studentId }))).status, 200);
    const listing = await (await members(context(null, null, owner, 'GET'))).json();
    assert.equal(listing.members[0].email, member.email);
    assert.equal(listing.members[0].studentId, member.studentId);
    assert.equal((await setMemberState(context({ email: member.email, enabled: false }, null, owner, 'PATCH'))).status, 200);
    assert.equal(db.prepare('SELECT enabled FROM admin_members WHERE email=?').get(member.email).enabled, 0);
    const logs = (await (await audit(context(null, null, owner, 'GET'))).json()).logs;
    assert.deepEqual(logs.map(row => row.action), ['member_disable', 'member_upsert', 'create']);
});

test('concurrent explicit profile creation commits once and a duplicate cannot leave partial data', async t => {
    const { db, trace, context } = await fixture(t);
    const submit = () => create(context({ ...recordInput, createStudent: true }));
    const responses = await Promise.all([submit(), submit()]);
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
    assert.equal(trace.reads.length, 0);
    for (const table of ['students', 'leave_share_records', 'admin_audit_log']) {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n, 1);
    }
});
