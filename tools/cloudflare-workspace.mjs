import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { localDirectory, wranglerConfig } from './cloudflare-config.mjs';

const exists = async file => lstat(file).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
});

export async function themeSelection(root, include) {
    const helperPath = path.join(root, 'tools', 'local-theme.mjs');
    const themePath = path.join(root, 'public', 'local-theme');
    if (!(await exists(helperPath))) {
        if (await exists(themePath)) throw new Error('缺少本地素材校验工具，不能发布 local-theme。');
        return [];
    }
    const helper = await import(pathToFileURL(helperPath).href);
    const activation = await helper.verifyThemeActivation(root);
    if (activation.active && !include) throw new Error('当前页面已启用自备素材；请显式添加 --include-local-theme，或先恢复默认外观。');
    if (!include) return [];
    const manifest = await helper.verifyLocalTheme(root);
    if (!Array.isArray(manifest.files)) throw new Error('本地素材清单无效。');
    return manifest.files;
}

async function copyDirectory(source, target, skipTheme = false) {
    const info = await lstat(source);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('发布目录必须是普通目录，不能使用符号链接。');
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
        if (skipTheme && entry.name === 'local-theme') continue;
        const from = path.join(source, entry.name), to = path.join(target, entry.name);
        if (entry.isSymbolicLink()) throw new Error('发布目录包含符号链接，请移除后重试。');
        if (entry.isDirectory()) await copyDirectory(from, to);
        else if (entry.isFile()) await copyFile(from, to);
        else throw new Error('发布目录包含不支持的文件类型。');
    }
}

export async function createWorkspace(root, config, mode, { withPermissions = false, themeFiles = [] } = {}) {
    const cache = localDirectory(root);
    await mkdir(cache, { recursive: true });
    const expected = path.join(await realpath(root), '.local', 'cloudflare');
    if (await realpath(cache) !== expected) throw new Error('本地配置目录不能通过符号链接指向项目之外。');
    const directory = await mkdtemp(path.join(cache, 'build-'));
    const cleanup = async () => {
        if (path.dirname(directory) !== path.resolve(cache) || !(path.basename(directory).startsWith('build-')) ||
            (await lstat(directory)).isSymbolicLink()) throw new Error('拒绝清理未经确认的临时目录。');
        await rm(directory, { recursive: true });
    };
    try {
        for (const name of ['public', 'functions', 'migrations']) {
            await copyDirectory(path.join(root, name), path.join(directory, name), name === 'public');
        }
        if (themeFiles.length) {
            const themeRoot = path.join(root, 'public', 'local-theme');
            for (const item of themeFiles) {
                if (typeof item.path !== 'string' || item.path.includes('\\') || path.isAbsolute(item.path) ||
                    item.path.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw new Error('素材清单路径无效。');
                const target = path.join(directory, 'public', 'local-theme', item.path);
                await mkdir(path.dirname(target), { recursive: true });
                await copyFile(path.join(themeRoot, item.path), target);
                if (item.sha256) {
                    const bytes = await readFile(target);
                    if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) {
                        throw new Error('素材在准备发布时发生变化，请重新校验。');
                    }
                }
            }
            await writeFile(path.join(directory, 'public', 'local-theme', 'manifest.json'), JSON.stringify({
                version: 1, files: themeFiles.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))
            }, null, 2) + '\n', 'utf8');
        }
        const update = async (next = config, permissions = withPermissions) => writeFile(path.join(directory, 'wrangler.jsonc'),
            JSON.stringify(wranglerConfig(next, mode, permissions), null, 2) + '\n', 'utf8');
        await update();
        return { directory, cleanup, update };
    } catch (error) { await cleanup(); throw error; }
}
