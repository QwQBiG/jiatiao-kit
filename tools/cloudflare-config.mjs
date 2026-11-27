import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MODES = ['preview', 'production'];
export const localDirectory = root => path.join(root, '.local', 'cloudflare');
export const configPath = root => path.join(localDirectory(root), 'local.json');
const fail = message => { throw new Error(message); };
const named = value => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
const uuid = value => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value || '');

export async function readLocal(root) {
    let text;
    try { text = await readFile(configPath(root), 'utf8'); }
    catch (error) {
        if (error.code === 'ENOENT') fail('请先运行 node tools/cloudflare.mjs configure。');
        throw error;
    }
    try { return JSON.parse(text); }
    catch { fail('本地 Cloudflare 配置不是有效 JSON，请检查 .local/cloudflare/local.json。'); }
}

export async function saveLocal(root, config) {
    await mkdir(localDirectory(root), { recursive: true });
    const temporary = path.join(localDirectory(root), 'config-' + crypto.randomUUID() + '.tmp');
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, configPath(root));
}

export function validateBase(config) {
    if (!config || !/^[0-9a-f]{32}$/i.test(config.accountId || '')) fail('请填写你自己的 32 位 Cloudflare 账户 ID。');
    if (!named(config.projectName)) fail('项目名请使用小写字母、数字及中间的连字符。');
    for (const key of ['productionBranch', 'previewBranch']) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/.test(config[key] || '')) fail('请填写明确的正式与预览分支。');
    }
    if (config.productionBranch === config.previewBranch) fail('预览分支必须与正式分支不同。');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(config.compatibilityDate || '') || !Number.isFinite(Date.parse(config.compatibilityDate))) {
        fail('兼容日期必须采用 YYYY-MM-DD 格式。');
    }
    for (const mode of MODES) {
        const database = config.databases?.[mode];
        if (!database || !named(database.name)) fail('请为预览和正式环境填写独立的 D1 数据库名。');
        if (database.id && !uuid(database.id)) fail('本地 D1 ID 格式无效，请重新运行 setup。');
    }
    const { preview, production } = config.databases;
    if (preview.name === production.name || (preview.id && preview.id.toLowerCase() === production.id?.toLowerCase())) fail('预览与正式环境必须使用不同的 D1 数据库。');
    return config;
}

export function permissionVars(config, mode) {
    const value = config.permissions?.[mode];
    const owners = value?.ownerEmails;
    if (!Array.isArray(owners) || !owners.length || owners.some(email => typeof email !== 'string' || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email))) {
        fail('请先运行 access，为所选环境配置有效的主管邮箱。');
    }
    let domain;
    try { domain = new URL(value.teamDomain); } catch { fail('请填写 Access 团队的 HTTPS 地址。'); }
    if (domain.protocol !== 'https:' || !domain.hostname.endsWith('.cloudflareaccess.com') ||
        domain.username || domain.password || domain.port || domain.search || domain.hash || !['', '/'].includes(domain.pathname)) {
        fail('Access 团队地址应为 https://你的团队.cloudflareaccess.com。');
    }
    if (!/^[0-9a-f]{64}$/i.test(value.aud || '')) fail('请填写所选 Access 应用的 64 位 AUD。');
    if (value.protected !== true) fail('请先在控制台保护所选环境的 /admin 和 /admin/*，再运行 access 确认。');
    return { OWNER_EMAILS: owners.map(email => email.trim().toLowerCase()).join(','), ACCESS_TEAM_DOMAIN: domain.origin, ACCESS_AUD: value.aud };
}

export function wranglerConfig(config, mode, withPermissions) {
    validateBase(config);
    const binding = selected => selected.id ? [{ binding: 'DB', database_name: selected.name, database_id: selected.id, migrations_dir: './migrations' }] : [];
    const varsFor = selected => withPermissions && (mode === selected || config.permissions?.[selected]?.protected === true)
        ? permissionVars(config, selected) : {};
    const vars = varsFor('production'), previewVars = varsFor('preview');
    return { name: config.projectName, pages_build_output_dir: './public', compatibility_date: config.compatibilityDate,
        vars, d1_databases: binding(config.databases.production),
        env: { production: { vars, d1_databases: binding(config.databases.production) },
            preview: { vars: previewVars, d1_databases: binding(config.databases.preview) } } };
}
