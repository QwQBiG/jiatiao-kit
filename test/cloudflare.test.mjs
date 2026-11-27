import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { cloudflare } from '../tools/cloudflare.mjs';
import { configPath, readLocal, saveLocal } from '../tools/cloudflare-config.mjs';
import { cliRunner } from '../tools/cloudflare-cli.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(path.join(directory, 'fixtures-'));
after(async () => {
    assert.equal(path.dirname(temporary), directory);
    assert.ok(path.basename(temporary).startsWith('fixtures-'));
    await rm(temporary, { recursive: true });
});
const ACCOUNT = 'a'.repeat(32), PREVIEW = '11111111-1111-4111-8111-111111111111', PRODUCTION = '22222222-2222-4222-8222-222222222222';
const permission = () => ({ ownerEmails: ['owner@example.invalid'], teamDomain: 'https://team.cloudflareaccess.com', aud: 'b'.repeat(64), protected: true });
let sequence = 0;
async function fixture({ ready = false } = {}) {
    const root = path.join(temporary, 'project-' + ++sequence);
    for (const folder of ['public', 'functions', 'migrations', 'tools']) await mkdir(path.join(root, folder), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n', 'utf8');
    await writeFile(path.join(root, 'public', 'index.html'), '<!doctype html><title>Fixture</title>', 'utf8');
    await writeFile(path.join(root, 'functions', 'hello.js'), "export function onRequest(){return new Response('Fixture')}\n", 'utf8');
    await writeFile(path.join(root, 'migrations', '0001.sql'), 'CREATE TABLE fixture(id TEXT);\n', 'utf8');
    await writeFile(path.join(root, 'wrangler.jsonc'), '{"name":"tracked-placeholder"}\n', 'utf8');
    await copyFile(path.join(directory, '..', 'cloudflare.example.json'), path.join(root, 'cloudflare.example.json'));
    const config = { accountId: ACCOUNT, projectName: 'fixture-project', productionBranch: 'main', previewBranch: 'template-preview',
        compatibilityDate: '2026-08-31', databases: { preview: { name: 'fixture-preview', id: ready ? PREVIEW : '' },
            production: { name: 'fixture-production', id: ready ? PRODUCTION : '' } },
        permissions: { preview: permission(), production: permission() } };
    if (ready) config.projectBinding = { accountId: ACCOUNT, projectName: config.projectName, productionBranch: 'main' };
    await saveLocal(root, config);
    return { root, config };
}
function mock(config, { ready = false, failMigration = false } = {}) {
    const state = { calls: [], project: ready, databases: ready ? [
        { name: config.databases.preview.name, uuid: PREVIEW }, { name: config.databases.production.name, uuid: PRODUCTION }
    ] : [], failMigration };
    state.run = async (args, options) => {
        assert.equal(options.accountId, ACCOUNT);
        assert.ok(path.relative(path.join(options.cwd, '..'), options.cwd).startsWith('build-'));
        const generated = JSON.parse(await readFile(path.join(options.cwd, 'wrangler.jsonc'), 'utf8'));
        state.calls.push({ args: [...args], generated });
        const result = value => ({ stdout: JSON.stringify(value) });
        if (args[0] === 'whoami') return result({ loggedIn: true, email: 'private@example.invalid', accounts: [{ id: ACCOUNT }] });
        if (args.slice(0, 3).join(' ') === 'pages project list') return result(state.project ? [{ 'Project Name': config.projectName, 'Git Provider': 'No' }] : []);
        if (args.slice(0, 3).join(' ') === 'pages project create') { state.project = true; return { stdout: '' }; }
        if (args.slice(0, 2).join(' ') === 'd1 list') return result(state.databases);
        if (args.slice(0, 2).join(' ') === 'd1 create') {
            state.databases.push({ name: args[2], uuid: args[2] === config.databases.preview.name ? PREVIEW : PRODUCTION });
            return { stdout: '' };
        }
        if (args.slice(0, 3).join(' ') === 'd1 migrations apply') {
            if (state.failMigration) throw new Error('Synthetic migration failure');
            const mode = args[args.indexOf('--env') + 1];
            assert.equal(generated.env[mode].d1_databases[0].binding, 'DB');
            assert.equal(generated.env[mode].d1_databases[0].database_id, mode === 'preview' ? PREVIEW : PRODUCTION);
            return { stdout: '' };
        }
        if (args.slice(0, 2).join(' ') === 'pages deploy') return { stdout: 'Deployment complete https://hash.fixture-project.pages.dev/?private=do-not-print' };
        throw new Error('Unexpected mock CLI operation');
    };
    return state;
}

test('default guide and invalid arguments never launch a CLI', async () => {
    let calls = 0;
    const options = { run() { calls++; throw new Error('Forbidden'); }, log() {} };
    await cloudflare([], options);
    await assert.rejects(cloudflare(['deploy', '--branch', 'main'], options), /参数无效/);
    assert.equal(calls, 0);
    const invalid = spawnSync(process.execPath, [path.join(directory, '../tools/cloudflare.mjs'), '--invalid'], { encoding: 'utf8' });
    assert.equal(invalid.status, 2);
});

test('configuration and Access prompts stay local, preserve re-entry and revoke a negative protection confirmation', async () => {
    const { root } = await fixture({ ready: true });
    const configuration = ['c'.repeat(32), 'own-project', '', ''];
    const options = { root, log() {}, run() { throw new Error('No CLI during local configuration'); } };
    await cloudflare(['configure'], { ...options, ask: async () => configuration.shift() });
    let saved = await readLocal(root);
    assert.equal(saved.databases.preview.name, 'own-project-preview');
    assert.equal(saved.databases.production.id, '');
    assert.deepEqual(saved.permissions.production.ownerEmails, []);
    const access = ['owner@example.invalid', 'https://team.cloudflareaccess.com', 'd'.repeat(64), 'yes'];
    await cloudflare(['access'], { ...options, ask: async () => access.shift() });
    saved = await readLocal(root);
    assert.equal(saved.permissions.preview.protected, true);
    assert.equal(saved.permissions.production.protected, false);
    const repeat = ['', '', '', ''];
    await cloudflare(['configure'], { ...options, ask: async () => repeat.shift() });
    assert.equal((await readLocal(root)).permissions.preview.protected, true);
    const rejected = ['', '', '', 'no'];
    await assert.rejects(cloudflare(['access'], { ...options, ask: async () => rejected.shift() }), /未确认保护/);
    assert.equal((await readLocal(root)).permissions.preview.protected, false);
});

test('first setup and re-entry reuse resources, migrate only preview and leave tracked config intact', async () => {
    const { root, config } = await fixture();
    const state = mock(config);
    const options = { root, run: state.run, log() {} };
    await cloudflare(['setup', '--yes'], options);
    await cloudflare(['setup', '--yes'], options);
    assert.equal(state.calls.filter(call => call.args.slice(0, 3).join(' ') === 'pages project create').length, 1);
    assert.equal(state.calls.filter(call => call.args.slice(0, 2).join(' ') === 'd1 create').length, 1);
    assert.ok(state.calls.filter(call => call.args.includes('apply')).every(call => call.args.at(-1) === 'preview'));
    const saved = await readLocal(root);
    assert.equal(saved.databases.preview.id, PREVIEW);
    assert.equal(saved.databases.production.id, '');
    assert.equal(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'), '{"name":"tracked-placeholder"}\n');
    assert.deepEqual((await readdir(path.dirname(configPath(root)))).filter(name => name.startsWith('build-')), []);
});

test('failed migration never deploys and the next setup resumes with its saved D1', async () => {
    const { root, config } = await fixture();
    const state = mock(config, { failMigration: true });
    await assert.rejects(cloudflare(['setup', '--yes'], { root, run: state.run, log() {} }), /Synthetic migration failure/);
    assert.equal((await readLocal(root)).databases.preview.id, PREVIEW);
    state.failMigration = false;
    await cloudflare(['setup', '--yes'], { root, run: state.run, log() {} });
    assert.equal(state.calls.filter(call => call.args[0] === 'd1' && call.args[1] === 'create').length, 1);
    assert.ok(!state.calls.some(call => call.args[1] === 'deploy'));
});

test('deploy defaults to an explicit preview branch and a distinct binding; production is explicit', async () => {
    const { root, config } = await fixture({ ready: true });
    const state = mock(config, { ready: true }), messages = [];
    await cloudflare(['deploy', '--yes'], { root, run: state.run, log: message => messages.push(message) });
    const preview = state.calls.find(call => call.args[1] === 'deploy');
    assert.equal(preview.args.at(-1), 'template-preview');
    assert.equal(preview.generated.d1_databases[0].database_id, PRODUCTION);
    assert.equal(preview.generated.env.preview.d1_databases[0].database_id, PREVIEW);
    assert.equal(preview.generated.env.preview.vars.ACCESS_AUD, config.permissions.preview.aud);
    assert.ok(!messages.join('\n').includes('private@example.invalid'));
    assert.ok(!messages.join('\n').includes('?private='));
    state.calls = [];
    await cloudflare(['deploy', '--production', '--yes'], { root, run: state.run, log() {} });
    const production = state.calls.find(call => call.args[1] === 'deploy');
    assert.equal(production.args.at(-1), 'main');
    assert.equal(production.generated.vars.ACCESS_AUD, config.permissions.production.aud);
    assert.ok(state.calls.filter(call => call.args.includes('apply')).every(call => call.args.at(-1) === 'production'));
});

test('missing permissions, shared databases, wrong accounts and declined consent cannot deploy', async () => {
    for (const invalid of ['owners', 'access', 'shared', 'case-shared']) {
        const { root, config } = await fixture({ ready: true });
        if (invalid === 'owners') config.permissions.production.ownerEmails = [];
        if (invalid === 'access') config.permissions.production.protected = false;
        if (invalid === 'shared') config.databases.preview.id = PRODUCTION;
        if (invalid === 'case-shared') {
            config.databases.production.id = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
            config.databases.preview.id = config.databases.production.id.toUpperCase();
        }
        await saveLocal(root, config);
        let calls = 0;
        await assert.rejects(cloudflare(['deploy', '--production', '--yes'], { root, run() { calls++; throw new Error('Forbidden'); }, log() {} }));
        assert.equal(calls, 0);
    }
    const { root, config } = await fixture({ ready: true });
    const state = mock(config, { ready: true });
    await cloudflare(['deploy'], { root, run: state.run, ask: async () => 'no', log() {} });
    assert.equal(state.calls.length, 0);
    await assert.rejects(cloudflare(['deploy', '--yes'], { root, log() {}, run: async () => ({ stdout: '{"accounts":[]}' }) }), /当前授权/);
});

test('a mismatched remote D1 ID stops before migration or deployment', async () => {
    const { root, config } = await fixture({ ready: true });
    const state = mock(config, { ready: true });
    state.databases[0].uuid = PRODUCTION;
    await assert.rejects(cloudflare(['deploy', '--yes'], { root, run: state.run, log() {} }), /ID 与远程数据库名不匹配/);
    assert.ok(!state.calls.some(call => call.args.includes('apply') || call.args[1] === 'deploy'));
});

test('existing projects with unknown production branches require a one-time adopt confirmation', async () => {
    const { root, config } = await fixture({ ready: true });
    delete config.projectBinding;
    await saveLocal(root, config);
    const state = mock(config, { ready: true });
    const options = { root, run: state.run, log() {} };
    await assert.rejects(cloudflare(['setup', '--yes'], options), /运行 adopt/);
    assert.ok(!state.calls.some(call => call.args.includes('create') || call.args.includes('apply') || call.args[1] === 'deploy'));
    const answers = ['main', config.projectName];
    await cloudflare(['adopt'], { ...options, ask: async () => answers.shift() });
    await cloudflare(['setup', '--yes'], options);
    await cloudflare(['deploy', '--yes'], options);
    assert.equal(state.calls.find(call => call.args[1] === 'deploy').args.at(-1), 'template-preview');
    const saved = await readLocal(root);
    saved.productionBranch = 'other';
    await saveLocal(root, saved);
    await assert.rejects(cloudflare(['deploy', '--yes'], options), /运行 adopt/);
});

async function localTheme(root) {
    const data = Buffer.from('body{color:inherit}\n');
    const item = { path: 'share/assets/theme.css', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    const themeRoot = path.join(root, 'public', 'local-theme');
    await mkdir(path.join(themeRoot, 'share', 'assets'), { recursive: true });
    await writeFile(path.join(themeRoot, item.path), data);
    await writeFile(path.join(themeRoot, 'manifest.json'), JSON.stringify({ version: 1, files: [item] }), 'utf8');
    await writeFile(path.join(root, 'tools', 'local-theme.mjs'), `
import {readFile,readdir} from 'node:fs/promises';import path from 'node:path';
export async function verifyThemeActivation(){return {active:true};}
export async function verifyLocalTheme(root){
 const folder=path.join(root,'public','local-theme');
 if((await readdir(folder)).sort().join(',')!=='manifest.json,share')throw Error('Unknown local theme files');
 return JSON.parse(await readFile(path.join(folder,'manifest.json'),'utf8'));
}`, 'utf8');
    return item;
}

test('active local theme requires explicit consent and only verified files enter the upload workspace', async () => {
    const { root, config } = await fixture({ ready: true });
    await localTheme(root);
    const state = mock(config, { ready: true });
    await assert.rejects(cloudflare(['deploy', '--yes'], { root, run: state.run, log() {} }), /include-local-theme/);
    assert.equal(state.calls.length, 0);
    const run = async (args, options) => {
        if (args[1] === 'deploy') {
            const folder = path.join(options.cwd, 'public', 'local-theme');
            assert.deepEqual((await readdir(folder)).sort(), ['manifest.json', 'share']);
            assert.equal(await readFile(path.join(folder, 'share', 'assets', 'theme.css'), 'utf8'), 'body{color:inherit}\n');
            const manifest = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8'));
            assert.deepEqual(Object.keys(manifest).sort(), ['files', 'version']);
        }
        return state.run(args, options);
    };
    await cloudflare(['deploy', '--yes', '--include-local-theme'], { root, run, log() {} });
    state.calls = [];
    await writeFile(path.join(root, 'public', 'local-theme', 'unexpected.txt'), 'private fixture', 'utf8');
    await assert.rejects(cloudflare(['deploy', '--yes', '--include-local-theme'], { root, run, log() {} }), /Unknown local theme/);
    assert.equal(state.calls.length, 0);
});

test('real local Wrangler builds Functions and reapplies only local preview migrations', async () => {
    const { root } = await fixture({ ready: true });
    const sourceRoot = process.cwd();
    for (const name of ['public', 'functions', 'migrations']) await cp(path.join(sourceRoot, name), path.join(root, name), {
        recursive: true,
        filter: source => name !== 'public' || !path.relative(path.join(sourceRoot, 'public'), source).split(path.sep).includes('local-theme')
    });
    const actual = cliRunner(root, () => {});
    let builds = 0;
    await cloudflare(['build'], { root, log() {}, run: async (args, options) => {
        assert.deepEqual(args.slice(0, 3), ['pages', 'functions', 'build']);
        const result = await actual(args, options);
        assert.ok((await readdir(path.join(options.cwd, 'worker'))).length > 0);
        const migration = ['d1', 'migrations', 'apply', 'DB', '--local', '--env', 'preview'];
        assert.ok(migration.includes('--local') && !migration.includes('--remote'));
        await actual(migration, options);
        await actual(migration, options);
        builds++;
        return result;
    } });
    assert.equal(builds, 1);
});
