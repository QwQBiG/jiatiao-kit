import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cliRunner, jsonResult } from './cloudflare-cli.mjs';
import { readLocal, saveLocal, validateBase, permissionVars } from './cloudflare-config.mjs';
import { createWorkspace, themeSelection } from './cloudflare-workspace.mjs';

const GUIDE = `Cloudflare Pages + D1 部署引导
所有账户和资源均使用你自己的配置，不含预设账户或数据库。

node tools/cloudflare.mjs configure   填写本地账户、项目与分支
node tools/cloudflare.mjs login       在浏览器中授权 Wrangler
node tools/cloudflare.mjs setup       准备预览项目和独立 D1，应用迁移
node tools/cloudflare.mjs adopt       既有项目首次接管时确认实际正式分支
node tools/cloudflare.mjs access      填写预览环境的 Access 配置
node tools/cloudflare.mjs build       仅在本地编译 Functions，不发布
node tools/cloudflare.mjs deploy      明确确认后发布预览

正式环境：setup、access、check、deploy 添加 --production。
远程写操作需交互确认，或由你显式添加 --yes。
自备素材仅在显式添加 --include-local-theme 且校验通过后发布。
完整步骤与管理路径保护见 docs/cloudflare.md。
控制台：https://dash.cloudflare.com/?to=/:account/workers-and-pages`;

function argumentsFor(argv) {
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { command: 'guide', flags: new Set() };
    const [command = 'guide', ...values] = argv;
    const permitted = { guide: [], configure: [], adopt: [], access: ['--production'], login: ['--device', '--no-browser'],
        setup: ['--production', '--yes'], check: ['--production'], build: ['--production', '--include-local-theme'],
        deploy: ['--production', '--yes', '--include-local-theme'] };
    if (!Object.hasOwn(permitted, command) || values.some(value => !permitted[command].includes(value)) || new Set(values).size !== values.length) {
        throw Object.assign(new Error('参数无效；运行 node tools/cloudflare.mjs --help 查看用法。'), { usage: true });
    }
    return { command, flags: new Set(values) };
}

async function configure(root, ask, log) {
    let previous;
    try { previous = await readLocal(root); } catch (error) {
        if (!error.message.startsWith('请先运行')) throw error;
    }
    const sample = previous || JSON.parse(await readFile(path.join(root, 'cloudflare.example.json'), 'utf8'));
    const config = structuredClone(sample);
    config.accountId = (await ask('你的 Cloudflare 账户 ID（已有值可留空保留）：')).trim() || config.accountId;
    config.projectName = (await ask('你的 Pages 项目名（已有值可留空保留）：')).trim() || config.projectName;
    config.productionBranch = (await ask('控制台确认的正式分支（默认 main）：')).trim() || config.productionBranch || 'main';
    config.previewBranch = (await ask('预览分支（默认 template-preview，必须与正式分支不同）：')).trim() || config.previewBranch || 'template-preview';
    if (!previous || previous.accountId !== config.accountId || previous.projectName !== config.projectName) {
        config.databases = { preview: { name: config.projectName + '-preview', id: '' }, production: { name: config.projectName + '-production', id: '' } };
        config.permissions = { preview: { ownerEmails: [], teamDomain: '', aud: '', protected: false },
            production: { ownerEmails: [], teamDomain: '', aud: '', protected: false } };
        delete config.projectBinding;
    }
    validateBase(config);
    await saveLocal(root, config);
    log('已保存忽略的本地配置；未登录、创建资源或发布。');
}

async function configureAccess(root, config, mode, ask, log) {
    log('请先在 Cloudflare Access 中保护该环境的 /admin 和 /admin/*（包括 API），覆盖实际使用的全部域名。');
    const current = config.permissions?.[mode] || {};
    const owners = (await ask('主管邮箱，多个用逗号分隔（已有值可留空保留）：')).trim();
    const teamDomain = (await ask('Access 团队完整 HTTPS 地址（已有值可留空保留）：')).trim() || current.teamDomain;
    const aud = (await ask('该环境 Access 应用 AUD（已有值可留空保留）：')).trim() || current.aud;
    const confirmed = (await ask('已确认上述管理路径和实际域名受 Access 保护？输入 yes：')).trim() === 'yes';
    config.permissions ||= {};
    if (!confirmed) {
        config.permissions[mode] = { ...current, protected: false };
        await saveLocal(root, config);
        throw new Error('已将该环境标记为未确认保护；部署将停止，完成控制台核对后重新运行 access。');
    }
    config.permissions[mode] = { ownerEmails: owners ? owners.split(',').map(value => value.trim()) : current.ownerEmails,
        teamDomain, aud, protected: true };
    permissionVars(config, mode);
    await saveLocal(root, config);
    log('已保存该环境权限配置；没有修改 Cloudflare Access 控制台。');
}

const rows = result => {
    const parsed = jsonResult(result);
    if (!Array.isArray(parsed)) throw new Error('Wrangler 列表格式不受支持，请检查本地 Wrangler 版本。');
    return parsed;
};

const projectBinding = config => ({ accountId: config.accountId, projectName: config.projectName, productionBranch: config.productionBranch });
const projectConfirmed = config => ['accountId', 'projectName', 'productionBranch'].every(key => config.projectBinding?.[key] === config[key]);

async function adopt(root, config, ask, log) {
    log('请先在控制台确认这是你要接管的项目，并查看其实际 production branch；本命令只记录你的核对结果。');
    const branch = (await ask('从控制台复制实际正式分支（不能留空）：')).trim();
    const name = (await ask('输入你确认接管的 Pages 项目名：')).trim();
    if (name !== config.projectName || !branch) throw new Error('项目或正式分支未明确确认，未保存。');
    config.productionBranch = branch;
    validateBase(config);
    config.projectBinding = projectBinding(config);
    await saveLocal(root, config);
    log('已保存账户、项目与正式分支的接管确认；未发布或修改线上资源。');
}

async function remoteState(config, mode, run, options, create, persistProject) {
    const identity = jsonResult(await run(['whoami', '--json'], options));
    if (identity.loggedIn === false || !identity.accounts?.some(account => account.id === config.accountId)) {
        throw new Error('当前授权不能访问配置的账户；请用你自己的账户运行 login 并核对账户 ID。');
    }
    const projects = rows(await run(['pages', 'project', 'list', '--json'], options));
    const project = projects.find(value => (value.name || value['Project Name']) === config.projectName);
    if (project?.source || project?.['Git Provider'] === 'Yes') throw new Error('请使用独立的 Direct Upload 项目，避免与 Git 自动发布冲突。');
    if (project?.production_branch && project.production_branch !== config.productionBranch) throw new Error('正式分支与远程项目不一致，请在 configure 中修正。');
    if (project && !project.production_branch && !projectConfirmed(config)) {
        throw new Error('既有项目的实际正式分支无法由 CLI 列表确认；请到控制台核对后运行 adopt，当前没有执行写操作。');
    }
    if (!project) {
        if (!create) throw new Error('项目不存在，请先运行 setup。');
        await run(['pages', 'project', 'create', config.projectName, '--production-branch', config.productionBranch,
            '--compatibility-date', config.compatibilityDate], options);
    }
    config.projectBinding = projectBinding(config);
    if (!project || create) await persistProject();
    const selected = config.databases[mode];
    let databases = rows(await run(['d1', 'list', '--json'], options));
    let database = databases.find(value => value.name === selected.name);
    if (!database) {
        if (!create) throw new Error('所选环境的 D1 不存在，请先运行 setup。');
        await run(['d1', 'create', selected.name, '--binding', 'DB', '--update-config=false'], options);
        databases = rows(await run(['d1', 'list', '--json'], options));
        database = databases.find(value => value.name === selected.name);
        if (!database) throw new Error('创建后尚未查到 D1，请稍后重新运行 setup。');
    }
    const id = database.uuid || database.id;
    if (!id) throw new Error('远程 D1 列表缺少数据库 ID，已停止。');
    if (selected.id && selected.id.toLowerCase() !== String(id).toLowerCase()) throw new Error('本地 D1 ID 与远程数据库名不匹配，已停止。');
    selected.id = id;
    validateBase(config);
    return config;
}

export async function cloudflare(argv = [], options = {}) {
    const root = path.resolve(options.root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const log = options.log || console.log;
    const { command, flags } = argumentsFor(argv);
    if (command === 'guide') { log(GUIDE); return; }
    let readline, workspace;
    const ask = options.ask || (async question => {
        if (!process.stdin.isTTY) throw new Error('非交互会话不能代替你确认；本地配置请手动填写，远程写操作需显式添加 --yes。');
        readline ||= createInterface({ input: process.stdin, output: process.stdout });
        return readline.question(question + ' ');
    });
    const run = options.run || cliRunner(root, log);
    const mode = flags.has('--production') ? 'production' : 'preview';
    try {
        if (command === 'configure') { await configure(root, ask, log); return; }
        if (command === 'login') {
            const args = ['login'];
            if (flags.has('--device')) args.push('--device');
            if (flags.has('--no-browser')) args.push('--browser=false');
            await run(args, { cwd: root, interactive: true });
            log('授权步骤结束；后续只使用本地配置中明确指定的账户。'); return;
        }
        const config = validateBase(await readLocal(root));
        if (command === 'adopt') { await adopt(root, config, ask, log); return; }
        if (command === 'access') { await configureAccess(root, config, mode, ask, log); return; }
        if (['deploy', 'check'].includes(command)) {
            permissionVars(config, mode);
            if (!config.databases[mode].id) throw new Error('所选环境尚未准备 D1，请先运行 setup。');
        }
        const themeFiles = ['deploy', 'build'].includes(command)
            ? await themeSelection(root, flags.has('--include-local-theme')) : [];
        if (['setup', 'deploy'].includes(command)) {
            log('环境：' + mode + '；项目：' + config.projectName + '；D1：' + config.databases[mode].name +
                '；分支：' + (mode === 'production' ? config.productionBranch : config.previewBranch));
            log(command === 'setup' ? '将创建缺少的项目或该环境 D1，并应用该环境迁移；不会发布页面。'
                : '将应用该环境未执行的迁移并发布该分支。' + (themeFiles.length ? ' 已明确包含校验过的本地素材，共 ' + themeFiles.length + ' 个文件。' : ' 不发布 local-theme 素材。'));
            if (!flags.has('--yes') && (await ask('确认使用你自己的 Cloudflare 账户继续？输入 yes：')).trim() !== 'yes') {
                log('已取消，没有访问或修改远程资源。'); return;
            }
        }
        workspace = await createWorkspace(root, config, mode, { withPermissions: command === 'deploy', themeFiles });
        const cliOptions = { cwd: workspace.directory, accountId: config.accountId };
        if (command === 'build') {
            await run(['pages', 'functions', 'build', 'functions', '--outdir', 'worker',
                '--build-output-directory', 'public', '--compatibility-date', config.compatibilityDate], cliOptions);
            log('本地 Functions 构建完成，未登录或发布。'); return;
        }
        await remoteState(config, mode, run, cliOptions, command === 'setup', () => saveLocal(root, config));
        if (command === 'check') { log('所选账户、项目、D1 和本地权限配置检查通过；没有发布。'); return; }
        await saveLocal(root, config);
        await workspace.update(config, command === 'deploy');
        log('正在应用 ' + mode + ' 环境的数据库迁移。');
        await run(['d1', 'migrations', 'apply', 'DB', '--remote', '--env', mode], cliOptions);
        if (command === 'setup') {
            log('该环境资源和迁移已就绪。请在控制台保护管理路径，再运行 access；尚未发布页面。'); return;
        }
        const branch = mode === 'production' ? config.productionBranch : config.previewBranch;
        log('正在发布 ' + mode + ' 分支；不会根据当前 Git 分支推断发布环境。');
        const result = await run(['pages', 'deploy', 'public', '--project-name', config.projectName, '--branch', branch], cliOptions);
        const deployment = result.stdout?.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.pages\.dev\/?/i)?.[0];
        log('发布完成。' + (deployment ? ' 地址：' + deployment : ' 请在 Workers & Pages 控制台查看本次部署地址。'));
    } finally {
        readline?.close();
        await workspace?.cleanup();
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    cloudflare(process.argv.slice(2)).catch(error => {
        console.error(error.message);
        process.exitCode = error.usage ? 2 : 1;
    });
}
