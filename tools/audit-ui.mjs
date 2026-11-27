import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPlainFiles, fingerprint } from './theme-files.mjs';
import { verifyThemeActivation } from './local-theme.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const allowedImages = new Set(['share-card/assets/leave-calendar.svg', 'share-card/assets/leave-calendar-a3e862826a10.png']);

export async function auditUi(root = projectRoot) {
    if ((await verifyThemeActivation(root)).active) throw Error('Restore the no-theme view before auditing the public source package');
    const publicRoot = path.join(root, 'public');
    const files = await listPlainFiles(publicRoot);
    const findings = [];
    const inventory = [];
    for (const file of files) {
        const bytes = await readFile(path.join(publicRoot, file));
        inventory.push({ path: file, bytes: bytes.length, sha256: fingerprint(bytes) });
        if (file.startsWith('local-theme/') || file.startsWith('support-demo/')) findings.push({ file, reason: 'Private or excluded resource directory' });
        if (/\.(?:png|webp|jpe?g|gif|svg|woff2?|ttf|otf)$/i.test(file)) {
            if (!allowedImages.has(file)) findings.push({ file, reason: 'Unknown binary or graphic resource' });
            continue;
        }
        if (!/\.(?:html|js|css|json)$/.test(file) && !['_headers', '_routes.json', '.gitignore'].includes(file)) {
            findings.push({ file, reason: 'Unknown public file type' }); continue;
        }
        const source = bytes.toString('utf8');
        if (/support-demo|smartServiceBtn|boyaSevice|base64,/i.test(source)) findings.push({ file, reason: 'Excluded branded flow or embedded binary' });
        const urls = source.match(/https?:\/\/[^\s'"<>),]+/g) || [];
        if (urls.some(url => url !== 'http://www.w3.org/2000/svg')) findings.push({ file, reason: 'Hard-coded external origin' });
    }
    if (findings.length) throw Object.assign(Error('UI source package audit failed'), { findings });
    return { passed: true, files: inventory, thirdPartyResources: 0, themeActive: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.length !== 2) throw Error('Usage: node tools/audit-ui.mjs');
        const result = await auditUi();
        console.log(JSON.stringify({ passed: result.passed, publicFiles: result.files.length, thirdPartyResources: 0, themeActive: false }));
    } catch (error) { console.error(JSON.stringify({ error: error.message, findings: error.findings })); process.exitCode = 1; }
}
