import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { onRequestPost as create, onRequestGet as list } from '../functions/admin/api/students.js';
import { onRequestPut as update, onRequestPatch as toggle } from '../functions/admin/api/students/[id].js';
import { onRequestGet as share } from '../functions/api/leave/[id].js';
import { onRequest as publicImage } from '../functions/api/leave/[id]/attachments/[aid].js';
import { onRequest as adminImage } from '../functions/admin/api/students/[id]/attachments/[aid].js';
import { decodeThumbnail } from '../functions/_shared/attachment-jpeg.js';
import { readRecordInput, MAX_BODY_BYTES } from '../functions/_shared/leave-attachments.js';

const JPEG = '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAwT/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCiwE53/9k=';
const DATA = 'data:image/jpeg;base64,' + JPEG;
const owner = { role: 'owner', email: 'owner@example.invalid' };
const input = { name: 'Demo', studentId: 'S1', gender: '男', grade: '2026', college: 'Demo',
    major: 'Demo', className: 'Demo', leaveType: '事假', approver: 'Demo', reason: 'before',
    destination: 'Demo', status: 'approved', startAt: '2026-10-01T00:00:00Z', endAt: '2026-10-02T00:00:00Z' };

async function fixture(t) {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    for (const file of (await readdir('migrations')).filter(file => file.endsWith('.sql')).sort()) {
        db.exec(await readFile('migrations/' + file, 'utf8'));
    }
    t.after(() => db.close());
    const queries = [];
    const wrap = (sql, values = []) => ({
        bind(...next) { return wrap(sql, next); },
        async first() { queries.push(sql); return db.prepare(sql).get(...values) || null; },
        async all() { queries.push(sql); return { results: db.prepare(sql).all(...values) }; },
        run() {
            return { results: db.prepare(sql).all(...values) };
        }
    });
    const DB = { prepare: sql => wrap(sql), async batch(statements) {
        if (DB.beforeBatch) { const before = DB.beforeBatch; DB.beforeBatch = null; before(); }
        db.exec('BEGIN');
        try { const result = statements.map(statement => statement.run()); db.exec('COMMIT'); return result; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
    } };
    const context = (body, id, user = owner, method = 'POST', aid) => ({ env: { DB },
        data: { adminUser: user }, params: { id, aid }, request: new Request('http://example.invalid/', {
            method, ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body) })
        }) });
    const add = async (attachments = [{ data: DATA }], extra = {}) => {
        const response = await create(context({ ...input, attachments, ...extra }));
        const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body)); return body.record;
    };
    const usage = () => db.prepare('SELECT total_bytes FROM leave_attachment_usage').get().total_bytes;
    return { db, DB, context, add, queries, usage };
}

test('JPEG marker validation preserves pixels bytes while removing EXIF, IPTC and comments', () => {
    const original = Buffer.from(JPEG, 'base64');
    const metadata = Buffer.from([255, 225, 0, 5, 71, 80, 83, 255, 237, 0, 4, 1, 2, 255, 254, 0, 4, 3, 4]);
    const decorated = Buffer.concat([original.subarray(0, 2), metadata, original.subarray(2)]);
    const image = decodeThumbnail('data:image/jpeg;base64,' + decorated.toString('base64'));
    assert.deepEqual(Buffer.from(image.bytes), original);
    assert.deepEqual([image.width, image.height], [2, 2]);
    assert.throws(() => decodeThumbnail('data:image/png;base64,' + JPEG), /ATTACHMENT_JPEG_ONLY/);
    assert.throws(() => decodeThumbnail('data:image/jpeg;base64,' + original.subarray(0, -2).toString('base64')), /INVALID_ATTACHMENT_JPEG/);
    assert.throws(() => decodeThumbnail('data:image/jpeg;base64,' + Buffer.alloc(24577).toString('base64')), /ATTACHMENT_TOO_LARGE/);
    const oversized = Buffer.from(original); const frame = oversized.indexOf(Buffer.from([255, 192]));
    oversized.writeUInt16BE(193, frame + 7);
    assert.throws(() => decodeThumbnail('data:image/jpeg;base64,' + oversized.toString('base64')), /ATTACHMENT_DIMENSIONS_EXCEEDED/);
});

test('bounded JSON reads enforce declared and actual streaming sizes without a Content-Length', async () => {
    assert.deepEqual(await readRecordInput(new Request('http://example.invalid', { method: 'POST', body: '{"reason":"ok"}' })), { reason: 'ok' });
    let cancelled = false;
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65536)); },
        cancel() { cancelled = true; } });
    await assert.rejects(readRecordInput(new Request('http://example.invalid', { method: 'POST', body: stream, duplex: 'half' })),
        error => error.message === 'BODY_TOO_LARGE' && error.status === 413);
    assert.equal(cancelled, true);
    await assert.rejects(readRecordInput(new Request('http://example.invalid', { method: 'POST', body: '{}',
        headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } })), /BODY_TOO_LARGE/);
    await assert.rejects(readRecordInput(new Request('http://example.invalid', { method: 'POST', body: 'bad' })), /INVALID_JSON/);
});

test('record manifests stay light, public reads remain one SELECT, and thumbnails use private binary routes', async t => {
    const f = await fixture(t); const record = await f.add(); const image = record.attachments[0];
    assert.deepEqual(Object.keys(image).sort(), ['height', 'id', 'url', 'width']);
    assert.match(image.url, /^\/admin\/api\/students\/[a-f0-9]{32}\/attachments\/[a-f0-9]{32}$/);
    assert.equal(f.usage(), Buffer.from(JPEG, 'base64').length);
    f.queries.length = 0;
    const payload = await (await share({ env: { DB: f.DB }, params: { id: record.shareId } })).json();
    assert.equal(f.queries.length, 1); assert.ok(!f.queries[0].includes('thumbnail'));
    assert.equal(payload.record.attachments[0].url, image.url.replace('/admin/api/students/', '/api/leave/'));
    assert.ok(!JSON.stringify(payload).includes(JPEG));
    const response = await publicImage(f.context(null, record.shareId, owner, 'GET', image.id));
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(JPEG, 'base64'));
    f.queries.length = 0;
    const head = await publicImage(f.context(null, record.shareId, owner, 'HEAD', image.id));
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.ok(!f.queries[0].includes('a.thumbnail'));
    const records = await (await list(f.context(null))).json();
    assert.deepEqual(records.records[0].attachments, record.attachments);
});

test('updates preserve omitted attachments, validate retained IDs, clear explicitly and never inherit a template', async t => {
    const f = await fixture(t); const record = await f.add(); const image = record.attachments[0];
    const save = async body => { const response = await update(f.context(body, record.shareId));
        return { status: response.status, body: await response.json() }; };
    assert.deepEqual((await save({ reason: 'text only' })).body.record.attachments, record.attachments);
    const other = await f.add();
    for (const attachments of [[{ id: image.id }, { id: image.id }], [{ id: other.attachments[0].id }],
        [{ id: image.id, data: DATA }], [{ data: DATA }, { data: DATA }, { data: DATA }, { data: DATA }]]) {
        assert.equal((await save({ attachments })).status, 400);
    }
    const member = { role: 'member', email: 'member@example.invalid', studentId: 'S1' };
    const own = await create(f.context({ reason: 'own new' }, null, member));
    assert.equal(own.status, 201); assert.deepEqual((await own.json()).record.attachments, []);
    const replaced = await save({ attachments: [{ id: image.id }, { data: DATA }] });
    assert.equal(replaced.status, 200); assert.equal(replaced.body.record.attachments[0].id, image.id);
    assert.equal(replaced.body.record.attachments.length, 2);
    assert.equal((await save({ attachments: [] })).status, 200);
    assert.equal((await publicImage(f.context(null, record.shareId, owner, 'GET', image.id))).status, 404);
});

test('thumbnail authorization follows ownership, live revocation and expiration while failures stay isolated', async t => {
    const f = await fixture(t); const record = await f.add(); const aid = record.attachments[0].id;
    const imageContext = (user = owner) => f.context(null, record.shareId, user, 'GET', aid);
    const member = { role: 'member', email: 'member@example.invalid', studentId: 'S1' };
    assert.equal((await adminImage(imageContext(member))).status, 200);
    assert.equal((await adminImage(imageContext({ ...member, studentId: 'S2' }))).status, 403);
    await toggle(f.context({ action: 'disable' }, record.shareId));
    assert.equal((await publicImage(imageContext())).status, 404);
    assert.equal((await adminImage(imageContext())).status, 200);
    await toggle(f.context({ action: 'restore' }, record.shareId));
    assert.equal((await publicImage(imageContext())).status, 200);
    f.db.prepare("UPDATE leave_share_records SET expires_at='2000-01-01' WHERE share_id=?").run(record.shareId);
    assert.equal((await publicImage(imageContext())).status, 410);
    assert.equal((await adminImage(imageContext())).status, 200);
    const broken = imageContext(); broken.env = { DB: { prepare() { throw new Error('image unavailable'); } } };
    assert.equal((await publicImage(broken)).status, 503);
    f.db.prepare('UPDATE leave_share_records SET expires_at=NULL WHERE share_id=?').run(record.shareId);
    f.db.prepare("UPDATE leave_share_records SET attachments_json='[null,{}, {\"id\":\"bad\"}]' WHERE share_id=?").run(record.shareId);
    const response = await share({ env: { DB: f.DB }, params: { id: record.shareId } });
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).record.attachments, []);
});

test('quota failures roll back record, audit, thumbnail and usage atomically; replacement reuses freed quota', async t => {
    const f = await fixture(t); const record = await f.add();
    f.db.exec('UPDATE leave_attachment_usage SET total_bytes=134217728');
    const count = table => f.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
    const before = { records: count('leave_share_records'), audit: count('admin_audit_log'), images: count('leave_record_attachments') };
    const failed = await create(f.context({ ...input, attachments: [{ data: DATA }] }));
    assert.equal(failed.status, 409); assert.equal((await failed.json()).error, 'ATTACHMENT_QUOTA_EXCEEDED');
    assert.deepEqual({ records: count('leave_share_records'), audit: count('admin_audit_log'), images: count('leave_record_attachments') }, before);
    assert.equal(f.usage(), 134217728);
    const failedUpdate = await update(f.context({ reason: 'must not save',
        attachments: [{ id: record.attachments[0].id }, { data: DATA }] }, record.shareId));
    assert.equal(failedUpdate.status, 409); assert.equal(f.usage(), 134217728);
    assert.equal(f.db.prepare('SELECT reason FROM leave_share_records WHERE share_id=?').get(record.shareId).reason, 'before');
    const replaced = await update(f.context({ attachments: [{ data: DATA }] }, record.shareId));
    assert.equal(replaced.status, 200); assert.equal(f.usage(), 134217728);
});

test('a concurrent manifest change returns 409 and cannot restore a deleted thumbnail or change usage', async t => {
    const f = await fixture(t); const record = await f.add();
    f.DB.beforeBatch = () => {
        f.db.prepare('DELETE FROM leave_record_attachments WHERE attachment_id=?').run(record.attachments[0].id);
        f.db.prepare("UPDATE leave_share_records SET attachments_json='[]', reason='other update' WHERE share_id=?").run(record.shareId);
    };
    const response = await update(f.context({ reason: 'stale update',
        attachments: [{ id: record.attachments[0].id }, { data: DATA }] }, record.shareId));
    assert.equal(response.status, 409); assert.equal((await response.json()).error, 'ATTACHMENT_CONFLICT');
    assert.equal(f.usage(), 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM leave_record_attachments').get().n, 0);
    assert.deepEqual({ ...f.db.prepare('SELECT reason, attachments_json FROM leave_share_records WHERE share_id=?').get(record.shareId) },
        { reason: 'other update', attachments_json: '[]' });
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM admin_audit_log').get().n, 1);
});

test('history pruning and direct SQL cascade-delete thumbnails and maintain bounded usage', async t => {
    const f = await fixture(t); const record = await f.add(); const bytes = Buffer.from(JPEG, 'base64');
    const row = f.db.prepare('SELECT token_hash FROM leave_share_records WHERE share_id=?').get(record.shareId);
    const insert = f.db.prepare(`INSERT INTO leave_record_attachments
        (token_hash, attachment_id, width, height, byte_size, thumbnail) VALUES (?, ?, 2, 2, ?, ?)`);
    f.db.exec('BEGIN');
    assert.throws(() => {
        for (let i = 1; i <= 3; i++) insert.run(row.token_hash, String(i).padStart(32, '0'), bytes.length, bytes);
    }, /ATTACHMENT_LIMIT_EXCEEDED/);
    f.db.exec('ROLLBACK');
    assert.equal(f.usage(), bytes.length);
    const changed = Buffer.concat([bytes.subarray(0, 2), Buffer.from([255, 224, 0, 4, 0, 0]), bytes.subarray(2)]);
    f.db.prepare('UPDATE leave_record_attachments SET byte_size=?, thumbnail=? WHERE token_hash=?')
        .run(changed.length, changed, row.token_hash);
    assert.equal(f.usage(), changed.length);
    for (let i = 0; i < 99; i++) await f.add([], { reason: 'history ' + i });
    f.db.exec(`CREATE TRIGGER test_audit_failure BEFORE INSERT ON admin_audit_log
        BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    const failed = await create(f.context({ ...input, attachments: [{ data: DATA }] }));
    assert.equal(failed.status, 400);
    assert.equal(f.usage(), changed.length);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM leave_record_attachments').get().n, 1);
    assert.ok(f.db.prepare('SELECT share_id FROM leave_share_records WHERE share_id=?').get(record.shareId));
    f.db.exec('DROP TRIGGER test_audit_failure');
    await f.add([], { reason: '101st record' });
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM leave_share_records').get().n, 100);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM leave_record_attachments').get().n, 0);
    assert.equal(f.usage(), 0);
    assert.equal((await publicImage(f.context(null, record.shareId, owner, 'GET', record.attachments[0].id))).status, 404);
});

test('POST and PUT return stable body errors without changing stored records or attachments', async t => {
    const f = await fixture(t); const record = await f.add();
    for (const [handler, id] of [[create, null], [update, record.shareId]]) {
        const context = f.context({}, id);
        context.request = new Request('http://example.invalid', { method: 'POST', body: '{}',
            headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } });
        const oversized = await handler(context);
        assert.equal(oversized.status, 413); assert.equal((await oversized.json()).error, 'BODY_TOO_LARGE');
        context.request = new Request('http://example.invalid', { method: 'POST', body: 'bad' });
        const malformed = await handler(context);
        assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error, 'INVALID_JSON');
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM leave_share_records').get().n, 1);
    assert.equal(f.usage(), Buffer.from(JPEG, 'base64').length);
});

test('obviously invalid JPEG scans require tables and nonempty entropy', () => {
    const bytes = Buffer.from(JPEG, 'base64');
    const segments = []; let at = 2;
    while (bytes[at + 1] !== 218) {
        const end = at + 2 + bytes.readUInt16BE(at + 2);
        segments.push(bytes.subarray(at, end)); at = end;
    }
    const scanEnd = at + 2 + bytes.readUInt16BE(at + 2);
    const noEntropy = Buffer.concat([bytes.subarray(0, scanEnd), Buffer.from([255, 217])]);
    assert.throws(() => decodeThumbnail('data:image/jpeg;base64,' + noEntropy.toString('base64')), /INVALID_ATTACHMENT_JPEG/);
    for (const marker of [219, 196]) {
        const missing = Buffer.concat([bytes.subarray(0, 2), ...segments.filter(segment => segment[1] !== marker), bytes.subarray(at)]);
        assert.throws(() => decodeThumbnail('data:image/jpeg;base64,' + missing.toString('base64')), /INVALID_ATTACHMENT_JPEG/);
    }
});
