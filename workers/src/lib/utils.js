/**
 * Utility functions for ChurchMouse Workers
 * Uses Web Crypto API (available in CF Workers natively)
 */

// ─── Response helpers ─────────────────────────────────────────────────────────

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

// ─── JWT (HS256 via Web Crypto) ───────────────────────────────────────────────

async function getJWTKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']
  );
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function parseB64url(str) {
  return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}

export async function signJWT(payload, secret, expiresInHours = 24) {
  const header  = { alg: 'HS256', typ: 'JWT' };
  const now     = Math.floor(Date.now() / 1000);
  const claims  = { ...payload, iat: now, exp: now + expiresInHours * 3600 };

  const headerB64  = b64url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getJWTKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));

  return `${signingInput}.${b64url(sig)}`;
}

export async function verifyJWT(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const key = await getJWTKey(env.JWT_SECRET);
    const signingInput = `${parts[0]}.${parts[1]}`;
    const sig = Uint8Array.from(parseB64url(parts[2]), c => c.charCodeAt(0));

    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(signingInput));
    if (!valid) return null;

    const payload = JSON.parse(parseB64url(parts[1]));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

// ─── Password hashing (PBKDF2 via Web Crypto) ─────────────────────────────────

export async function hashPassword(password) {
  const enc  = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  // Store as: salt_hex:hash_hex
  const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
  return `${hex(salt)}:${hex(bits)}`;
}

export async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;

  const enc  = new TextEncoder();
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const key  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
  return hex(bits) === hashHex;
}

// ─── Role guards ──────────────────────────────────────────────────────────────

export function requireRole(user, ...roles) {
  return roles.includes(user.role);
}

export function isAdminOrCM(user) {
  return user.role === 'admin' || user.role === 'content_manager';
}

// ─── ID generation ────────────────────────────────────────────────────────────

export function newId() {
  return crypto.randomUUID().replace(/-/g, '');
}

// ─── Email via MailChannels (free on CF Workers) ──────────────────────────────

export async function sendEmail(to, subject, html, env) {
    console.log("Sending email via Resend to:", to);

    /*
    console.log("Hello World");
    console.log("ENV OBJECT:", env);
    console.log("ENV KEYS:", Object.keys(env));
    console.log("KEY:", env.RESEND_API_KEY);
    console.log("Test KEY:", env.TEST);
  */


    const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            from: "noreply@churchmouse.co.za",
            to,
            subject,
            html
        })
    });

    const text = await r.text();

    console.log("Resend status:", r.status);
    console.log("Resend response:", text);

    return r.ok;
}
