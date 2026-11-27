import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_IMAGE_PATH, SHARE_PAGE_PATH, recordShareUrl, cardDetails } from '../public/share-card/share.js';
import { isSharePage, renderShareHead, renderShareHeadStream } from '../functions/_shared/share-card.js';
import { verifyThemeActivation, verifyLocalTheme, restoreLocalTheme } from '../tools/local-theme.mjs';
import { fingerprint, validateSources, writeKnownFiles, checkedBytes, listPlainFiles } from '../tools/theme-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pageFile = 'public' + SHARE_PAGE_PATH;

test('share addresses default to the current origin and retain the supported path', () => {
    const id = '0123456789abcdef0123456789abcdef';
    assert.ok(recordShareUrl(id).startsWith(SHARE_PAGE_PATH + '?'));
    globalThis.location = { origin: 'https://example.test' };
    try { assert.ok(recordShareUrl(id).startsWith('https://example.test' + SHARE_PAGE_PATH)); }
    finally { delete globalThis.location; }
    assert.throws(() => recordShareUrl('../invalid'), /INVALID_SHARE_ID/);
    const card = cardDetails('https://example.test' + SHARE_PAGE_PATH);
    assert.equal(card.imageUrl, 'https://example.test' + CARD_IMAGE_PATH);
    assert.equal(isSharePage(SHARE_PAGE_PATH), true);
    assert.equal(isSharePage('/admin/'), false);
});

test('public HTML retains the shell and renders safe initial metadata identically as a stream', async () => {
    const html = await readFile(path.join(root, pageFile), 'utf8');
    const url = 'https://example.test' + SHARE_PAGE_PATH;
    const initial = { status: 200, id: '0'.repeat(32), record: { name: '<example>' } };
    const expected = renderShareHead(html, url, initial);
    const streamed = renderShareHeadStream(new Response(html).body, url, initial);
    assert.equal(await new Response(streamed).text(), expected);
    assert.ok(expected.includes('leaveResponseClock'));
    assert.ok(!expected.includes('"name":"<example>"'));
    assert.ok(!html.includes('support-demo'));
    assert.ok(!html.includes('base64,'));
    assert.ok(html.indexOf('id="initialLoadingToast"') < html.indexOf('id="app"'));
    assert.equal((await verifyThemeActivation(root)).active, false);
});

test('bounded local-theme primitives copy only fingerprinted authored fixture files', async () => {
    const sandbox = await mkdtemp(path.join(root, 'test/.theme-fixture-'));
    try {
        const sourceRoot = path.join(sandbox, 'source');
        const targetRoot = path.join(sandbox, 'target');
        await mkdir(sourceRoot);
        const bytes = Buffer.from('/* authored fixture */\n', 'utf8');
        const file = { source: 'fixture.css', path: 'share/assets/fixture.css', bytes: bytes.length, sha256: fingerprint(bytes) };
        await writeFile(path.join(sourceRoot, file.source), bytes);
        const values = await validateSources(sourceRoot, [file]);
        await writeKnownFiles(targetRoot, [file], values);
        assert.deepEqual(await checkedBytes(targetRoot, file.path, file), bytes);
        assert.deepEqual(await listPlainFiles(targetRoot), [file.path]);
        await assert.rejects(checkedBytes(targetRoot, '../outside.css', file), /Invalid theme path/);
        await writeFile(path.join(targetRoot, file.path), 'changed', 'utf8');
        await assert.rejects(checkedBytes(targetRoot, file.path, file), /mismatch/);
        await mkdir(path.join(sandbox, 'public/local-theme'), { recursive: true });
        await writeFile(path.join(sandbox, 'public/local-theme/manifest.json'), '{"version":1,"files":[]}', 'utf8');
        await assert.rejects(verifyLocalTheme(sandbox), /Unknown theme manifest/);
    } finally {
        assert.ok(sandbox.startsWith(path.join(root, 'test') + path.sep));
        await rm(sandbox, { recursive: true });
    }
});

test('activation has an explicit all-or-nothing state without importing any theme bytes', async () => {
    const sandbox = await mkdtemp(path.join(root, 'test/.activation-fixture-'));
    try {
        const entries = JSON.parse(await readFile(path.join(root, 'tools/theme-activation.json'), 'utf8'));
        for (const file of new Set(entries.map(entry => entry.file))) {
            await mkdir(path.dirname(path.join(sandbox, file)), { recursive: true });
            await writeFile(path.join(sandbox, file), await readFile(path.join(root, file), 'utf8'), 'utf8');
        }
        assert.deepEqual(await verifyThemeActivation(sandbox), { active: false });
        for (const file of new Set(entries.map(entry => entry.file))) {
            let text = await readFile(path.join(sandbox, file), 'utf8');
            for (const entry of entries.filter(entry => entry.file === file)) text = text.replace(entry.off, entry.on);
            await writeFile(path.join(sandbox, file), text, 'utf8');
        }
        assert.deepEqual(await verifyThemeActivation(sandbox), { active: true });
        const first = entries[0];
        const changed = (await readFile(path.join(sandbox, first.file), 'utf8')).replace(first.on, first.off);
        await writeFile(path.join(sandbox, first.file), changed, 'utf8');
        await assert.rejects(verifyThemeActivation(sandbox), /incomplete/);
        assert.deepEqual(await restoreLocalTheme(sandbox), { active: false, privateFilesRetained: true });
        assert.deepEqual(await verifyThemeActivation(sandbox), { active: false });
        assert.deepEqual(await listPlainFiles(path.join(sandbox, 'public/admin')), ['admin.css', 'index.html']);
    } finally {
        assert.ok(sandbox.startsWith(path.join(root, 'test') + path.sep));
        await rm(sandbox, { recursive: true });
    }
});
