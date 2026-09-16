/**
 * Auth routes
 * POST /api/auth/login
 * POST /api/auth/logout
 * POST /api/auth/forgot-password
 * POST /api/auth/reset-password
 * POST /api/auth/change-password  (requires auth – user resets own password)
 */

import {
  jsonResponse, errorResponse,
  verifyPassword, hashPassword,
  signJWT, verifyJWT,
  sendEmail, newId
} from '../lib/utils.js';

export async function handleAuth(request, env, path) {
  const method = request.method;

  // ── POST /auth/login ────────────────────────────────────────────────────────
  if (path === '/auth/login' && method === 'POST') {
    const { email, password } = await request.json();
    if (!email || !password) return errorResponse('Email and password required');

    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE email = ? COLLATE NOCASE'
    ).bind(email.trim().toLowerCase()).first();

    if (!user || !user.is_active) return errorResponse('Invalid credentials', 401);

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return errorResponse('Invalid credentials', 401);

    // Recorded only past the password check, so this is genuinely the last
    // *successful* sign-in and not merely the last attempt. Awaited rather than
    // fired and forgotten: without ctx.waitUntil here, a floating promise can be
    // cut off when the response ends. It is one indexed write on a route that
    // runs once per session.
    await env.DB.prepare(
      'UPDATE users SET last_login_at = unixepoch() WHERE id = ?'
    ).bind(user.id).run();

    const token = await signJWT(
      { sub: user.id, email: user.email, role: user.role, name: user.name },
      env.JWT_SECRET,
      72   // 3 days
    );

    return jsonResponse({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  }

  // ── POST /auth/forgot-password ───────────────────────────────────────────────
  if (path === '/auth/forgot-password' && method === 'POST') {
    const { email } = await request.json();
    if (!email) return errorResponse('Email required');

    const user = await env.DB.prepare(
      'SELECT id, name FROM users WHERE email = ? AND is_active = 1 COLLATE NOCASE'
    ).bind(email.trim().toLowerCase()).first();

    // Always return success to prevent email enumeration
    if (!user) return jsonResponse({ message: 'If that address is registered you will receive an email.' });

    const token   = newId() + newId();
    const expires = Math.floor(Date.now() / 1000) + 3600; // 1 hour

    await env.DB.prepare(
      'UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?'
    ).bind(token, expires, user.id).run();

    const resetUrl = `${env.FRONTEND_URL}/#reset?token=${token}`;
      const emailSent = await sendEmail(
          email,
          'ChurchMouse Music – Password Reset',
          `<p>Hi ${user.name},</p>
   <p>Click the link below to reset your password. This link expires in 1 hour.</p>
   <p><a href="${resetUrl}">${resetUrl}</a></p>
   <p>If you did not request this, ignore this email.</p>`, env
      );

      if (!emailSent) {
          console.error('Failed to send reset email');
          return errorResponse('Failed to send reset email', 500);
      }

    return jsonResponse({ message: 'If that address is registered you will receive an email.' });
  }

    // ── Guard against GET /auth/reset-password ──────────────────────────────
    if (path === '/auth/reset-password' && method !== 'POST') {
        return errorResponse('Method not allowed', 405);
    }

  // ── POST /auth/reset-password ────────────────────────────────────────────────
  if (path === '/auth/reset-password' && method === 'POST') {
    const { token, newPassword } = await request.json();
    if (!token || !newPassword) return errorResponse('Token and new password required');
    if (newPassword.length < 8)  return errorResponse('Password must be at least 8 characters');

    const now  = Math.floor(Date.now() / 1000);
    const user = await env.DB.prepare(
      'SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > ?'
    ).bind(token, now).first();

    if (!user) return errorResponse('Invalid or expired token', 400);

    const hash = await hashPassword(newPassword);
    await env.DB.prepare(
      'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, updated_at = ? WHERE id = ?'
    ).bind(hash, now, user.id).run();

    return jsonResponse({ message: 'Password updated. You can now log in.' });
  }

  // ── POST /auth/change-password (authenticated) ───────────────────────────────
  if (path === '/auth/change-password' && method === 'POST') {
    const user = await verifyJWT(request, env);
    if (!user) return errorResponse('Unauthorized', 401);

    const { currentPassword, newPassword } = await request.json();
    if (!currentPassword || !newPassword) return errorResponse('Both passwords required');
    if (newPassword.length < 8)           return errorResponse('New password must be at least 8 characters');

    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.sub).first();
    if (!row) return errorResponse('User not found', 404);

    const ok = await verifyPassword(currentPassword, row.password_hash);
    if (!ok) return errorResponse('Current password incorrect', 403);

    const hash = await hashPassword(newPassword);
    await env.DB.prepare(
      'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'
    ).bind(hash, Math.floor(Date.now() / 1000), user.sub).run();

    return jsonResponse({ message: 'Password changed successfully.' });
  }

  return errorResponse('Not found', 404);
}
