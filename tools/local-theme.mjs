import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedBytes, plainPath, listPlainFiles, validateSources, writeKnownFiles, atomicTextFile } from './theme-files.mjs';

const toolRoot = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(await readFile(path.join(toolRoot, 'theme-catalog.json'), 'utf8'));
const activation = JSON.parse(await readFile(path.join(toolRoot, 'theme-activation.json'), 'utf8'));
const projectRoot = path.resolve(toolRoot, '..');
const themeRelative = 'public/local-theme';
const publicFiles = catalog.files.map(({ path: name, sha256, bytes }) => ({ path: name, sha256, bytes }));

async function activationState(root, allowMixed = false) {
    const contents = new Map();
    const states = [];
    for (const item of activation) {
        if (!contents.has(item.file)) contents.set(item.file, await readFile(await plainPath(root, item.file), 'utf8'));
        const text = contents.get(item.file);
        const off = text.split(item.off).length - 1;
        const on = text.split(item.on).length - 1;
        if (off + on !== 1) throw Error('Theme activation marker changed: ' + item.file);
        states.push(on === 1);
    }
    const mixed = !states.every(state => state === states[0]);
    if (mixed && !allowMixed) throw Error('Theme activation is incomplete; restore before publishing');
    return { active: !mixed && states[0], mixed, contents };
}

export async function verifyThemeActivation(root = projectRoot) {
    return { active: (await activationState(root)).active };
}

async function setActivation(root, active) {
    const state = await activationState(root, true);
    if (!state.mixed && state.active === active) return;
    for (const item of activation) {
        state.contents.set(item.file, state.contents.get(item.file).replace(
            active ? item.off : item.on, active ? item.on : item.off));
    }
    for (const [file, text] of state.contents) await atomicTextFile(await plainPath(root, file), text);
}

export async function restoreLocalTheme(root = projectRoot) {
    await setActivation(root, false);
    return { active: false, privateFilesRetained: true };
}

export async function verifyLocalTheme(root = projectRoot) {
    const themeRoot = await plainPath(root, themeRelative);
    if (!(await lstat(themeRoot)).isDirectory()) throw Error('Local theme is not a directory');
    const manifestFile = await plainPath(themeRoot, 'manifest.json');
    if ((await lstat(manifestFile)).size > 16384) throw Error('Theme manifest is too large');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (manifest.version !== 1 || JSON.stringify(manifest.files) !== JSON.stringify(publicFiles) ||
        Object.keys(manifest).sort().join(',') !== 'files,version') throw Error('Unknown theme manifest');
    const actual = await listPlainFiles(themeRoot);
    const expected = [...publicFiles.map(file => file.path), 'manifest.json'].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Unknown or missing local theme files');
    for (const file of publicFiles) await checkedBytes(themeRoot, file.path, file);
    return { version: 1, files: publicFiles.map(file => ({ ...file })) };
}

async function importTheme(sourceRoot, authorized) {
    if (!authorized) throw Error('Import requires --authorized: confirm permission for every allowlisted asset');
    await activationState(projectRoot, true);
    const contents = await validateSources(path.resolve(sourceRoot), catalog.files);
    const themeRoot = await plainPath(projectRoot, themeRelative);
    try {
        const found = await listPlainFiles(themeRoot);
        if (found.some(file => file !== 'manifest.json' && !publicFiles.some(item => item.path === file))) {
            throw Error('Unknown local theme files; import will not overwrite this directory');
        }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeKnownFiles(themeRoot, publicFiles, contents);
    await atomicTextFile(await plainPath(themeRoot, 'manifest.json'), JSON.stringify({ version: 1, files: publicFiles }, null, 2) + '\n');
    await verifyLocalTheme();
    await setActivation(projectRoot, true);
    return { imported: publicFiles.length, active: true };
}

async function main(args) {
    const [command, ...options] = args;
    if (command === 'verify' && options.length === 0) {
        const state = await verifyThemeActivation();
        return state.active ? { ...state, ...await verifyLocalTheme() } : state;
    }
    if (command === 'restore' && options.length === 0) {
        return restoreLocalTheme();
    }
    if (command === 'source-check' && options.length === 1 && options[0].startsWith('--source=')) {
        await validateSources(path.resolve(options[0].slice(9)), catalog.files);
        return { verified: publicFiles.length, copied: 0 };
    }
    if (command === 'import' && options.length === 2 && options[0].startsWith('--source=') && options[1] === '--authorized') {
        return importTheme(options[0].slice(9), true);
    }
    throw Error('Usage: local-theme.mjs verify | restore | source-check --source=<public-dir> | import --source=<public-dir> --authorized');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
