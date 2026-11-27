import { lstat, readFile, readdir, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function safeRelative(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(value) ||
        value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
        throw Error('Invalid theme path');
    }
    return value;
}

export async function plainPath(root, relative) {
    let current = path.resolve(root);
    const parts = safeRelative(relative).split('/');
    for (const part of parts) {
        current = path.join(current, part);
        try {
            if ((await lstat(current)).isSymbolicLink()) throw Error('Theme symlinks are not allowed');
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
    }
    return current;
}

export function fingerprint(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

export async function atomicTextFile(target, text) {
    const temporary = target + '.theme-' + randomUUID() + '.tmp';
    try {
        await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
}

export async function checkedBytes(root, relative, expected) {
    const target = await plainPath(root, relative);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size !== expected.bytes) throw Error('Theme file size mismatch: ' + relative);
    const bytes = await readFile(target);
    if (fingerprint(bytes) !== expected.sha256) throw Error('Theme fingerprint mismatch: ' + relative);
    return bytes;
}

export async function validateSources(sourceRoot, files) {
    const values = [];
    for (const file of files) values.push(await checkedBytes(sourceRoot, file.source, file));
    return values;
}

export async function writeKnownFiles(targetRoot, files, contents) {
    for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const target = await plainPath(targetRoot, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        try {
            await writeFile(target, contents[index], { flag: 'wx' });
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            await checkedBytes(targetRoot, file.path, file);
        }
    }
}

export async function listPlainFiles(root, prefix = '') {
    const files = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (entry.isSymbolicLink()) throw Error('Theme symlinks are not allowed');
        if (entry.isDirectory()) files.push(...await listPlainFiles(path.join(root, entry.name), relative + '/'));
        else if (entry.isFile()) files.push(relative);
        else throw Error('Unexpected theme filesystem entry');
    }
    return files.sort();
}
