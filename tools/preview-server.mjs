import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { onRequestGet } from '../functions/api/leave/[id].js';
import { onRequest as publicAttachment } from '../functions/api/leave/[id]/attachments/[aid].js';
import { onRequest as adminAttachment } from '../functions/admin/api/students/[id]/attachments/[aid].js';
import { isSharePage, renderShareHead } from '../functions/_shared/share-card.js';
import { SHARE_PAGE_PATH } from '../public/share-card/share.js';
import { onRequestGet as getSession } from '../functions/admin/api/session.js';
import { onRequestGet as listStudents, onRequestPost as createStudent } from '../functions/admin/api/students.js';
import {
    onRequestGet as getStudent,
    onRequestPut as updateStudent,
    onRequestPatch as changeStudentState
} from '../functions/admin/api/students/[id].js';
import {
    onRequestGet as listMembers,
    onRequestPost as saveMember,
    onRequestPatch as changeMemberState
} from '../functions/admin/api/members.js';
import { onRequestGet as listAudit } from '../functions/admin/api/audit.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const port = Number(process.env.PORT || 8788);
const headerConfig = await readFile(path.join(publicRoot, '_headers'), 'utf8');
const adminCsp = /\/admin\/\*\r?\n\s+Content-Security-Policy:\s*([^\r\n]+)/.exec(headerConfig)?.[1];

const database = new DatabaseSync(':memory:');
const migrationFiles = (await readdir(path.join(projectRoot, 'migrations')))
    .filter((name) => name.endsWith('.sql')).sort();
for (const migrationFile of migrationFiles) {
    database.exec(await readFile(path.join(projectRoot, 'migrations', migrationFile), 'utf8'));
}
function wrapStatement(statement, values = []) {
    const bindings = () => values.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    return {
        bind(...nextValues) {
            return wrapStatement(statement, nextValues);
        },
        async first() {
            return statement.get(...bindings()) || null;
        },
        async all() {
            return { results: statement.all(...bindings()) };
        },
        async run() {
            return statement.run(...bindings());
        },
        _run() {
            return { results: statement.all(...bindings()) };
        }
    };
}

const d1Adapter = {
    prepare(sql) {
        return wrapStatement(database.prepare(sql));
    },
    async batch(statements) {
        database.exec('BEGIN');
        try {
            const results = statements.map((statement) => statement._run());
            database.exec('COMMIT');
            return results;
        } catch (error) {
            database.exec('ROLLBACK');
            throw error;
        }
    }
};

const owner = Object.freeze({ email: 'owner@example.test', role: 'owner', studentId: null });
const now = Date.now();
const seed = await createStudent({
    request: new Request('http://127.0.0.1/admin/api/students', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            createStudent: true, name: '演示同学', studentId: 'DEMO-001', gender: '女',
            grade: '一年级', college: '示例学院', major: '示例专业', className: '演示一班',
            leaveType: '事假', approver: '演示老师', reason: '测试页面展示', destination: '示例地点',
            status: 'approved', startAt: new Date(now - 3600000), endAt: new Date(now + 3600000)
        })
    }), env: { DB: d1Adapter }, data: { adminUser: owner }
});
if (seed.status !== 201) throw Error('Could not create the local example record');
const { record: example } = await seed.json();

const mimeTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'], ['.woff2', 'font/woff2'], ['.woff', 'font/woff'], ['.ttf', 'font/ttf']
]);

async function sendFetchResponse(nodeResponse, response) {
    nodeResponse.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    nodeResponse.end(Buffer.from(await response.arrayBuffer()));
}

async function serveApi(nodeResponse, id) {
    const response = await onRequestGet({ params: { id }, env: { DB: d1Adapter } });
    await sendFetchResponse(nodeResponse, response);
}

async function toFetchRequest(request) {
    const url = new URL(request.url, 'http://' + request.headers.host);
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : Readable.toWeb(request);
    return new Request(url, {
        method: request.method,
        headers: request.headers,
        body, duplex: 'half'
    });
}

async function serveAdminApi(nodeRequest, nodeResponse, pathname) {
    const request = await toFetchRequest(nodeRequest);
    const context = {
        request,
        env: { DB: d1Adapter },
        data: { adminUser: owner },
        params: {}
    };
    const method = request.method.toUpperCase();
    let handler;
    if (pathname === '/admin/api/session' && method === 'GET') handler = getSession;
    if (pathname === '/admin/api/students' && method === 'GET') handler = listStudents;
    if (pathname === '/admin/api/students' && method === 'POST') handler = createStudent;
    if (pathname === '/admin/api/members' && method === 'GET') handler = listMembers;
    if (pathname === '/admin/api/members' && method === 'POST') handler = saveMember;
    if (pathname === '/admin/api/members' && method === 'PATCH') handler = changeMemberState;
    if (pathname === '/admin/api/audit' && method === 'GET') handler = listAudit;
    const studentMatch = pathname.match(/^\/admin\/api\/students\/([0-9a-f]{32})$/i);
    if (studentMatch) {
        context.params.id = studentMatch[1];
        if (method === 'GET') handler = getStudent;
        if (method === 'PUT') handler = updateStudent;
        if (method === 'PATCH') handler = changeStudentState;
    }
    const attachmentMatch = pathname.match(/^\/admin\/api\/students\/([0-9a-f]{32})\/attachments\/([0-9a-f]{32})$/i);
    if (attachmentMatch) {
        context.params = { id: attachmentMatch[1], aid: attachmentMatch[2] };
        if (method === 'GET' || method === 'HEAD') handler = adminAttachment;
    }
    if (!handler) {
        nodeResponse.writeHead(405).end('Method Not Allowed');
        return;
    }
    await sendFetchResponse(nodeResponse, await handler(context));
}

async function serveStatic(nodeResponse, pathname, pageUrl) {
    let relativePath = decodeURIComponent(pathname);
    if (relativePath.endsWith('/')) relativePath += 'index.html';
    const filePath = path.resolve(publicRoot, '.' + relativePath);
    if (!filePath.startsWith(publicRoot + path.sep)) {
        nodeResponse.writeHead(403).end('Forbidden');
        return;
    }
    try {
        let content = await readFile(filePath);
        if (isSharePage(pathname)) content = Buffer.from(renderShareHead(content.toString('utf8'), pageUrl), 'utf8');
        const headers = {
            'Content-Type': mimeTypes.get(path.extname(filePath)) || 'application/octet-stream',
            'Cache-Control': 'no-store'
        };
        if (pathname.startsWith('/admin/') && adminCsp) headers['Content-Security-Policy'] = adminCsp;
        nodeResponse.writeHead(200, headers);
        nodeResponse.end(content);
    } catch (error) {
        if (error.code !== 'ENOENT') console.error(error);
        nodeResponse.writeHead(404).end('Not Found');
    }
}

const server = createServer(async (request, response) => {
    try {
        const host = '127.0.0.1:' + server.address().port;
        if (request.headers.host !== host ||
            (request.headers.origin && request.headers.origin !== 'http://' + host)) {
            response.writeHead(403).end('Forbidden');
            return;
        }
        const url = new URL(request.url, 'http://' + host);
        if (url.origin !== 'http://' + host) {
            response.writeHead(400).end('Bad Request');
            return;
        }
        if (url.pathname === '/demo' && ['GET', 'HEAD'].includes(request.method)) {
            response.writeHead(302, { Location: SHARE_PAGE_PATH + '?id=' + example.shareId }).end();
            return;
        }
        const attachment = url.pathname.match(/^\/api\/leave\/([0-9a-f]{32})\/attachments\/([0-9a-f]{32})$/i);
        if (attachment) {
            const incoming = await toFetchRequest(request);
            const handler = ['HEAD', 'GET'].includes(incoming.method) ? publicAttachment : null;
            await sendFetchResponse(response, handler ? await handler({ request: incoming,
                params: { id: attachment[1], aid: attachment[2] }, env: { DB: d1Adapter } }) :
                new Response('Method Not Allowed', { status: 405 }));
            return;
        }
        const match = url.pathname.match(/^\/api\/leave\/([^/]+)$/);
        if (match) {
            if (request.method !== 'GET') {
                response.writeHead(405, { Allow: 'GET' }).end('Method Not Allowed');
                return;
            }
            await serveApi(response, match[1]);
            return;
        }
        if (url.pathname.startsWith('/admin/api/')) {
            await serveAdminApi(request, response, url.pathname);
            return;
        }
        if (!['HEAD', 'GET'].includes(request.method)) {
            response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed');
            return;
        }
        await serveStatic(response, url.pathname, url.href);
    } catch (error) {
        console.error(error);
        response.writeHead(500).end('Internal Server Error');
    }
});

server.listen(port, '127.0.0.1', () => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    console.log('本地说明 ' + origin + '/');
    console.log('演示假条 ' + origin + '/demo');
    console.log('管理页面 ' + origin + '/admin/');
});

function shutdown() {
    server.close(() => {
        database.close();
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
