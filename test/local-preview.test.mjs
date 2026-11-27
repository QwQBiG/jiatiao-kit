import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

test('a fresh preview links to a synthetic record and restricts local administration', { timeout: 15000 }, async t => {
    const processHandle = spawn(process.execPath, ['tools/preview-server.mjs'], {
        cwd: new URL('../', import.meta.url), env: { ...process.env, PORT: '0' },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const closed = once(processHandle, 'close');
    t.after(async () => {
        processHandle.kill();
        await closed;
    });
    let log = '';
    processHandle.stderr.setEncoding('utf8').on('data', chunk => { log += chunk; });
    const origin = await new Promise((resolve, reject) => {
        let output = '';
        processHandle.stdout.setEncoding('utf8').on('data', chunk => {
            output += chunk;
            const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(output);
            if (url) resolve(new URL(url[0]).origin);
        });
        processHandle.once('error', reject);
        processHandle.once('close', code => reject(Error('Preview exited ' + code + '\n' + log)));
    });

    assert.equal((await fetch(origin + '/')).status, 200);
    const start = await fetch(origin + '/demo', { redirect: 'manual' });
    assert.equal(start.status, 302);
    const pageUrl = new URL(start.headers.get('location'), origin);
    assert.equal(pageUrl.origin, origin);
    const id = pageUrl.searchParams.get('id');
    assert.match(id, /^[\da-f]{32}$/);
    const document = await fetch(pageUrl);
    assert.equal(document.status, 200);
    assert.match(await document.text(), /<title>请假<\/title>/);
    assert.equal((await fetch(origin + '/admin/')).status, 200);
    const api = origin + '/api/leave/' + id;
    const payload = await (await fetch(api)).json();
    assert.equal(payload.record.name, '演示同学');

    const admin = origin + '/admin/api/students/' + id;
    const disable = { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disable' }) };
    assert.equal((await fetch(admin, { ...disable, headers: {
        ...disable.headers, Origin: 'https://example.invalid' } })).status, 403);
    assert.equal((await fetch(api)).status, 200);
    assert.equal((await fetch(admin, disable)).status, 200);
    assert.ok([404, 410].includes((await fetch(api)).status));
    assert.equal((await fetch(api, { method: 'POST' })).status, 405);
});
