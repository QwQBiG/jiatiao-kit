import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { onRequestPost } from '../../functions/admin/api/students.js';

export const owner = { role: 'owner', email: 'owner@example.invalid', studentId: null };
export const member = { role: 'member', email: 'member@example.invalid', studentId: 'EXAMPLE-001' };
export const recordInput = {
    name: '示例同学', shortName: '示例', studentId: 'EXAMPLE-001', gender: '女', grade: '2026',
    college: '示例学院', major: '示例专业', className: '示例班级', dorm: '-',
    leaveType: '事假', needLeaveSchool: false, approver: '演示管理员', reason: '示例原因', destination: '示例地点',
    status: 'pending', startAt: '2026-01-01T00:00:00.000Z', endAt: '2026-01-02T00:00:00.000Z'
};

export async function fixture(t) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec('PRAGMA foreign_keys=ON');
    const migrations = new URL('../../migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
        db.exec(await readFile(new URL(name, migrations), 'utf8'));
    }
    const trace = { reads: [], batches: [] };
    function wrap(sql, values = []) {
        return {
            sql,
            bind(...next) { return wrap(sql, next); },
            async first() { trace.reads.push(sql); return db.prepare(sql).get(...values) || null; },
            async all() { trace.reads.push(sql); return { results: db.prepare(sql).all(...values) }; },
            execute() { return { results: db.prepare(sql).all(...values) }; }
        };
    }
    const DB = {
        prepare: sql => wrap(sql),
        async batch(statements) {
            trace.batches.push(statements.map(statement => statement.sql));
            db.exec('BEGIN');
            try {
                const results = statements.map(statement => statement.execute());
                db.exec('COMMIT');
                return results;
            } catch (error) { db.exec('ROLLBACK'); throw error; }
        }
    };
    const context = (body = {}, id, user = owner, method = 'POST') => ({
        env: { DB }, data: { adminUser: user }, params: { id }, request: new Request('https://example.invalid/admin/api/students', {
            method, ...(method === 'GET' || method === 'HEAD' ? {} : {
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            })
        })
    });
    async function add(body = recordInput) {
        const response = await onRequestPost(context(body));
        const payload = await response.json();
        assert.equal(response.status, 201, payload.error);
        return payload.record;
    }
    return { db, DB, trace, context, add };
}
