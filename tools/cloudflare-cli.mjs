import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function cliRunner(root, log = console.log) {
    return async (args, { cwd = root, accountId, interactive = false } = {}) => {
        let executable;
        try {
            const require = createRequire(path.join(root, 'package.json'));
            const packagePath = require.resolve('wrangler/package.json');
            const metadata = JSON.parse(await readFile(packagePath, 'utf8'));
            executable = path.resolve(path.dirname(packagePath), metadata.bin.wrangler);
        } catch { throw new Error('未找到本地 Wrangler，请先在项目根目录运行 npm install。'); }
        const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
        if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
        if (!interactive) env.CI = 'true';
        return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [executable, ...args], {
                cwd, env, shell: false, windowsHide: true, stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe']
            });
            let stdout = '', finished = false;
            child.stdout?.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
            child.stderr?.resume();
            const progress = setInterval(() => log('Cloudflare 步骤仍在执行，请等待完成。'), 30000);
            const timeout = setTimeout(() => {
                child.kill();
                finish(new Error('Cloudflare 步骤超时；可修复网络后重新执行，已创建的资源会复用。'));
            }, args.includes('deploy') ? 600000 : 120000);
            function finish(error, result) {
                if (finished) return;
                finished = true; clearInterval(progress); clearTimeout(timeout);
                if (error) reject(error); else resolve(result);
            }
            child.on('error', () => finish(new Error('无法启动本地 Wrangler，请检查 Node.js 与依赖。')));
            child.on('close', code => finish(code === 0 ? null : new Error(
                'Wrangler 步骤失败（退出码 ' + code + '）。请检查网络、账户权限或在本机运行对应 Wrangler 命令诊断；不要公开授权日志。'
            ), { stdout }));
        });
    };
}

export function jsonResult(result) {
    try { return JSON.parse(result.stdout); }
    catch { throw new Error('Wrangler 返回的 JSON 无法解析，请检查本地 Wrangler 版本；原始账户输出未记录。'); }
}
