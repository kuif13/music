/**
 * User management routes (Admin only)
 * GET    /api/users          – list all users
 * POST   /api/users          – create user
 * GET    /api/users/:id      – get user
 * PATCH  /api/users/:id      – update (name, role, is_active)
 * POST   /api/users/:id/reset-password  – admin resets password
 */

import {
  jsonResponse, errorResponse,
  hashPassword, requireRole, newId, sendEmail
} from '../lib/utils.js';

export async function handleUsers(request, env, path, user) {
  if (!requireRole(user, 'admin')) return errorResponse('Forbidden', 403);

  const method  = request.method;
  const idMatch = path.match(/^\/users\/([^/]+)/);
  const userId  = idMatch ? idMatch[1] : null;

  // ── GET /users ───────────────────────────────────────────────────────────────
  if (!userId && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, email, name, role, is_active, created_at, last_login_at FROM users ORDER BY name'
    ).all();
    return jsonResponse(results);
  }

  // ── POST /users (create) ─────────────────────────────────────────────────────
  if (!userId && method === 'POST') {
    const { email, name, role, password } = await request.json();
    if (!email || !name || !role || !password) return errorResponse('email, name, role and password are required');
    if (!['admin','content_manager','reader'].includes(role)) return errorResponse('Invalid role');
    if (password.length < 8) return errorResponse('Password must be at least 8 characters');

    const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').bind(email.toLowerCase()).first();
    if (exists) return errorResponse('Email already registered', 409);

    const id   = newId();
    const hash = await hashPassword(password);
    const now  = Math.floor(Date.now() / 1000);

    await env.DB.prepare(
      'INSERT INTO users (id, email, name, role, password_hash, is_active, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)'
    ).bind(id, email.toLowerCase().trim(), name.trim(), role, hash, now, now).run();

    return jsonResponse({ id, email: email.toLowerCase(), name, role, is_active: 1 }, 201);
  }

  // ── GET /users/:id ───────────────────────────────────────────────────────────
  if (userId && method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT id, email, name, role, is_active, created_at, last_login_at FROM users WHERE id = ?'
    ).bind(userId).first();
    if (!row) return errorResponse('User not found', 404);
    return jsonResponse(row);
  }

  // ── PATCH /users/:id ─────────────────────────────────────────────────────────
  if (userId && method === 'PATCH') {
    const body = await request.json();
    const sets = [];
    const vals = [];

    if (body.name      !== undefined) { sets.push('name = ?');      vals.push(body.name.trim()); }
    if (body.role      !== undefined) {
      if (!['admin','content_manager','reader'].includes(body.role)) return errorResponse('Invalid role');
      sets.push('role = ?'); vals.push(body.role);
    }
    if (body.is_active !== undefined) { sets.push('is_active = ?'); vals.push(body.is_active ? 1 : 0); }

    if (sets.length === 0) return errorResponse('Nothing to update');
    sets.push('updated_at = ?');
    vals.push(Math.floor(Date.now() / 1000));
    vals.push(userId);

    await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    return jsonResponse({ message: 'Updated' });
  }

  // ── POST /users/:id/reset-password ───────────────────────────────────────────
  if (userId && path.endsWith('/reset-password') && method === 'POST') {
    const { newPassword } = await request.json();
    if (!newPassword || newPassword.length < 8) return errorResponse('Password must be at least 8 characters');

    const row = await env.DB.prepare('SELECT email, name FROM users WHERE id = ?').bind(userId).first();
    if (!row) return errorResponse('User not found', 404);

    const hash = await hashPassword(newPassword);
    await env.DB.prepare(
      'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'
    ).bind(hash, Math.floor(Date.now() / 1000), userId).run();

    // Notify user by email
    await sendEmail(
      row.email,
      'ChurchMouse Music – Your Password Has Been Reset',
      `<p>Hi ${row.name},</p>
       <p>Your password has been reset by an administrator.</p>
       <p>Your new temporary password is: <strong>${newPassword}</strong></p>
       <p>Please change it after logging in.</p>`, env
    );

    return jsonResponse({ message: 'Password reset and email sent.' });
  }

  return errorResponse('Not found', 404);
}
