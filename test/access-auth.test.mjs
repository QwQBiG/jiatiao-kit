import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test, { before } from 'node:test';
import { onRequest } from '../functions/admin/api/_middleware.js';
import { fixture, owner, member } from './helpers/database.mjs';

const team = 'https://access.example.invalid', audience = 'example-audience';
let keyPair, publicKey;
before(async () => {
    keyPair = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    publicKey = { ...await webcrypto.subtle.exportKey('jwk', keyPair.publicKey), kid: 'example-test-key' };
});
async function token(email, claims = {}, header = {}) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const signed = encode({ alg: 'RS256', kid: publicKey.kid, ...header }) + '.' + encode({
        iss: team, aud: audience, exp: Math.floor(Date.now() / 1000) + 3600, email, ...claims
    });
    const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, Buffer.from(signed));
    return signed + '.' + Buffer.from(signature).toString('base64url');
}
function credentials(t) {
    t.mock.method(globalThis, 'fetch', async url => {
        assert.equal(String(url), team + '/cdn-cgi/access/certs');
        return Response.json({ keys: [publicKey] });
    });
}
function context(jwt, env, headers = {}) {
    const value = { env, data: {}, nextCalled: false,
        request: new Request('https://admin.example.invalid/admin/api/session', {
            headers: { ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}), ...headers }
        }), next() {
            value.nextCalled = true;
            return Response.json({ user: value.data.adminUser });
        } };
    return value;
}
const configured = DB => ({ DB, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: audience, OWNER_EMAILS: owner.email });

test('production middleware rejects missing configuration, missing login and loopback identity hints', async t => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(globalThis, 'fetch', () => assert.fail('Unauthenticated requests must not fetch keys'));
    const DB = { prepare() { assert.fail('Unauthenticated requests must not read records'); } };
    const contexts = [context(null, {}), context(null, configured(DB)),
        context(null, { ...configured(DB), LOCAL_ADMIN_EMAIL: owner.email },
            { Host: '127.0.0.1', 'x-local-role': 'owner', 'x-local-student-id': 'EXAMPLE-001' }),
        context(await token(owner.email), { DB, OWNER_EMAILS: owner.email })];
    for (const value of contexts) {
        const response = await onRequest(value);
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: 'AUTH_REQUIRED' });
        assert.equal(value.nextCalled, false);
    }
});

test('verified owner allowlist supplies the same session DTO without membership queries', async t => {
    credentials(t);
    const DB = { prepare() { assert.fail('Configured owners do not need a membership query'); } };
    const value = context(await token('OWNER@example.invalid'), configured(DB));
    const response = await onRequest(value);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user: owner });
    assert.equal(value.nextCalled, true);
});

test('member identity and enabled state are rechecked in SQLite on every request', async t => {
    credentials(t); t.mock.method(console, 'error', () => {});
    const { db, DB } = await fixture(t);
    db.prepare('INSERT INTO admin_members(email,display_name,student_id) VALUES (?,?,?)')
        .run(member.email, '示例成员', member.studentId);
    const jwt = await token(member.email, { role: 'owner', studentId: 'OTHER' });
    const response = await onRequest(context(jwt, configured(DB)));
    assert.deepEqual(await response.json(), { user: member });
    db.prepare('UPDATE admin_members SET student_id=? WHERE email=?').run('EXAMPLE-002', member.email);
    const rebound = await onRequest(context(jwt, configured(DB)));
    assert.equal((await rebound.json()).user.studentId, 'EXAMPLE-002');
    db.prepare('UPDATE admin_members SET enabled=0 WHERE email=?').run(member.email);
    const disabled = context(jwt, configured(DB));
    assert.equal((await onRequest(disabled)).status, 403);
    assert.equal(disabled.nextCalled, false);
    assert.equal((await onRequest(context(await token('unknown@example.invalid'), configured(DB)))).status, 403);
});

test('invalid signature, algorithm, issuer, audience and expired tokens never reach a handler', async t => {
    credentials(t); t.mock.method(console, 'error', () => {});
    const valid = await token(owner.email), pieces = valid.split('.');
    const signature = Buffer.from(pieces[2], 'base64url'); signature[0] ^= 1;
    pieces[2] = signature.toString('base64url');
    const invalid = [pieces.join('.'), await token(owner.email, {}, { alg: 'HS256' }),
        await token(owner.email, { iss: 'https://other.example.invalid' }),
        await token(owner.email, { aud: 'other-audience' }), await token(owner.email, { exp: 0 })];
    const DB = { prepare() { assert.fail('Invalid tokens must not access membership or records'); } };
    for (const jwt of invalid) {
        const value = context(jwt, configured(DB));
        assert.equal((await onRequest(value)).status, 401);
        assert.equal(value.nextCalled, false);
    }
});
