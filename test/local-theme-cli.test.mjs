import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fingerprint } from '../tools/theme-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('theme CLI imports only an explicitly authorized authored fixture and restores partial activation', async () => {
    const sandbox = await mkdtemp(path.join(root, 'test/.theme-cli-'));
    try {
        const project = path.join(sandbox, 'project');
        const source = path.join(sandbox, 'authorized');
        const activation = JSON.parse(await readFile(path.join(root, 'tools/theme-activation.json'), 'utf8'));
        const catalog = JSON.parse(await readFile(path.join(root, 'tools/theme-catalog.json'), 'utf8'));
        const ownFiles = new Set(['tools/theme-files.mjs', 'tools/local-theme.mjs', 'tools/theme-activation.json',
            ...activation.map(item => item.file)]);
        for (const file of ownFiles) {
            await mkdir(path.dirname(path.join(project, file)), { recursive: true });
            await writeFile(path.join(project, file), await readFile(path.join(root, file), 'utf8'), 'utf8');
        }
        // This private fixture replaces only catalog fingerprints with authored test bytes.
        // The executable remains identical; no original CSS, image or font is copied.
        for (const [index, file] of catalog.files.entries()) {
            const bytes = Buffer.from('authored test resource ' + index + '\n', 'utf8');
            file.bytes = bytes.length; file.sha256 = fingerprint(bytes);
            await mkdir(path.dirname(path.join(source, file.source)), { recursive: true });
            await writeFile(path.join(source, file.source), bytes);
        }
        await writeFile(path.join(project, 'tools/theme-catalog.json'), JSON.stringify(catalog), 'utf8');
        const run = (...args) => spawnSync(process.execPath, [path.join(project, 'tools/local-theme.mjs'), ...args], { encoding: 'utf8' });
        const denied = run('import', '--source=' + source);
        assert.equal(denied.status, 1); assert.match(denied.stderr, /--authorized/);
        const checked = run('source-check', '--source=' + source);
        assert.equal(checked.status, 0); assert.equal(JSON.parse(checked.stdout).copied, 0);
        const imported = run('import', '--source=' + source, '--authorized');
        assert.equal(imported.status, 0, imported.stderr);
        assert.deepEqual(JSON.parse(imported.stdout), { imported: 12, active: true });
        const verified = run('verify');
        assert.equal(verified.status, 0, verified.stderr);
        assert.equal(JSON.parse(verified.stdout).files.length, 12);
        const unexpected = path.join(project, 'public/local-theme/extra.txt');
        await writeFile(unexpected, 'not allowed', 'utf8');
        const unknown = run('verify'); assert.equal(unknown.status, 1); assert.match(unknown.stderr, /Unknown or missing/);
        await rm(unexpected);
        const marker = activation[0];
        const file = path.join(project, marker.file);
        await writeFile(file, (await readFile(file, 'utf8')).replace(marker.on, marker.off), 'utf8');
        assert.equal(run('verify').status, 1);
        const retried = run('import', '--source=' + source, '--authorized');
        assert.equal(retried.status, 0, retried.stderr);
        assert.equal(run('verify').status, 0);
        const restored = run('restore');
        assert.equal(restored.status, 0, restored.stderr);
        assert.deepEqual(JSON.parse(run('verify').stdout), { active: false });
        const manifest = JSON.parse(await readFile(path.join(project, 'public/local-theme/manifest.json'), 'utf8'));
        assert.equal(manifest.files.length, 12);
    } finally {
        assert.ok(sandbox.startsWith(path.join(root, 'test') + path.sep));
        await rm(sandbox, { recursive: true });
    }
});
