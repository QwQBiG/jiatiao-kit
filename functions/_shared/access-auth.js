import { json } from './http.js';

var keyCache = new Map();

function decodePart(value) {
    var normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    var binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    return Uint8Array.from(binary, function (character) { return character.charCodeAt(0); });
}

function decodeJson(value) {
    return JSON.parse(new TextDecoder().decode(decodePart(value)));
}

function ownerEmails(env) {
    return new Set(String(env.OWNER_EMAILS || '').split(',')
        .map(function (email) { return email.trim().toLowerCase(); })
        .filter(Boolean));
}

async function verifyAccessToken(token, env) {
    var parts = token.split('.');
    if (parts.length !== 3) throw new Error('INVALID_TOKEN');
    var header = decodeJson(parts[0]);
    var payload = decodeJson(parts[1]);
    if (header.alg !== 'RS256' || !header.kid) throw new Error('INVALID_ALGORITHM');

    var teamDomain = String(env.ACCESS_TEAM_DOMAIN || '').replace(/\/$/, '');
    var expectedIssuer = teamDomain;
    var now = Math.floor(Date.now() / 1000);
    var audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!teamDomain || !env.ACCESS_AUD || payload.iss !== expectedIssuer ||
        !audiences.includes(env.ACCESS_AUD) || typeof payload.exp !== 'number' ||
        payload.exp <= now || (typeof payload.nbf === 'number' && payload.nbf > now) ||
        typeof payload.email !== 'string') {
        throw new Error('INVALID_CLAIMS');
    }

    var cacheKey = teamDomain + ':' + header.kid;
    var publicKey = keyCache.get(cacheKey);
    if (!publicKey) {
        var response = await fetch(teamDomain + '/cdn-cgi/access/certs');
        if (!response.ok) throw new Error('CERTS_UNAVAILABLE');
        var jwks = await response.json();
        var jwk = (jwks.keys || []).find(function (key) { return key.kid === header.kid; });
        if (!jwk) throw new Error('UNKNOWN_KEY');
        publicKey = await crypto.subtle.importKey(
            'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
        );
        keyCache.set(cacheKey, publicKey);
    }

    var valid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5', publicKey, decodePart(parts[2]),
        new TextEncoder().encode(parts[0] + '.' + parts[1])
    );
    if (!valid) throw new Error('INVALID_SIGNATURE');
    return payload;
}

export async function authenticate(context) {
    var token = context.request.headers.get('Cf-Access-Jwt-Assertion') || '';
    if (!token) throw new Error('AUTH_REQUIRED');
    var claims = await verifyAccessToken(token, context.env);
    var email = claims.email.toLowerCase();
    if (ownerEmails(context.env).has(email)) return { email, role: 'owner', studentId: null };

    var member = await context.env.DB.prepare(
        'SELECT email, role, student_id FROM admin_members WHERE email = ?1 AND enabled = 1 LIMIT 1'
    ).bind(email).first();
    if (!member) throw new Error('NOT_AUTHORIZED');
    return { email, role: member.role, studentId: member.student_id };
}

export async function requireAdmin(context) {
    try {
        return await authenticate(context);
    } catch (error) {
        console.error('Admin authentication failed', error.message);
        return json({ error: error.message === 'NOT_AUTHORIZED' ? 'NOT_AUTHORIZED' : 'AUTH_REQUIRED' },
            error.message === 'NOT_AUTHORIZED' ? 403 : 401);
    }
}
