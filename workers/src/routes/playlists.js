/**
 * Playlist routes
 * GET    /api/playlists                    – my playlists + public ones
 * POST   /api/playlists                    – create
 * GET    /api/playlists/:id                – get playlist + items
 * PUT    /api/playlists/:id                – update header
 * DELETE /api/playlists/:id                – delete
 * POST   /api/playlists/:id/items          – add item
 * PUT    /api/playlists/:id/items/:itemId  – update item description or order
 * DELETE /api/playlists/:id/items/:itemId  – remove item
 */

import {
  jsonResponse, errorResponse,
  isAdminOrCM, newId
} from '../lib/utils.js';

const DAY_SECS = 86400;

export async function handlePlaylists(request, env, path, user) {
  const method = request.method;

  // Route patterns
  const listBase  = path === '/playlists';
  const idMatch   = path.match(/^\/playlists\/([^/]+)(?:\/(.*))?$/);
  const plId      = idMatch ? idMatch[1] : null;
  const subPath   = idMatch ? (idMatch[2] || '') : '';
  const itemMatch = subPath.match(/^items(?:\/([^/]+))?$/);

  const now = Math.floor(Date.now() / 1000);

  // ── GET /playlists ────────────────────────────────────────────────────────────
  if (listBase && method === 'GET') {
    const { results } = await env.DB.prepare(`
      SELECT p.*, u.name AS owner_name,
             (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS item_count
      FROM playlists p
      JOIN users u ON u.id = p.owner_id
      WHERE (p.owner_id = ? OR p.is_public = 1)
        AND p.expires_at > ?
      ORDER BY p.updated_at DESC
    `).bind(user.sub, now).all();

    return jsonResponse(results);
  }

  // ── POST /playlists (create) ──────────────────────────────────────────────────
  if (listBase && method === 'POST') {
    const { title, is_public, expires_at } = await request.json();
    if (!title?.trim()) return errorResponse('Title is required');

    // Only admin/CM can make public
    const pub = is_public && isAdminOrCM(user) ? 1 : 0;
    const exp = expires_at || (now + 3 * DAY_SECS);
    const id  = newId();

    await env.DB.prepare(
      'INSERT INTO playlists (id, title, owner_id, is_public, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(id, title.trim(), user.sub, pub, exp, now, now).run();

    return jsonResponse({ id, title: title.trim(), is_public: pub, expires_at: exp }, 201);
  }

  // ── GET /playlists/:id ────────────────────────────────────────────────────────
  if (plId && !subPath && method === 'GET') {
    const pl = await env.DB.prepare(
      'SELECT p.*, u.name AS owner_name FROM playlists p JOIN users u ON u.id = p.owner_id WHERE p.id = ?'
    ).bind(plId).first();

    if (!pl) return errorResponse('Not found', 404);
    if (!canViewPlaylist(pl, user)) return errorResponse('Forbidden', 403);

    const { results: items } = await env.DB.prepare(`
      SELECT pi.id, pi.display_desc, pi.sort_order, pi.added_at,
             pd.id AS pdf_id, pd.description AS pdf_desc, pd.key_signature, pd.file_name,
             mm.id AS master_id, mm.title AS master_title
      FROM playlist_items pi
      JOIN pdf_detail pd ON pd.id = pi.pdf_detail_id
      JOIN music_master mm ON mm.id = pd.master_id
      WHERE pi.playlist_id = ?
      ORDER BY pi.sort_order, pi.added_at
    `).bind(plId).all();

    return jsonResponse({ ...pl, items });
  }

  // ── PUT /playlists/:id (update header) ────────────────────────────────────────
  if (plId && !subPath && method === 'PUT') {
    const pl = await env.DB.prepare('SELECT * FROM playlists WHERE id = ?').bind(plId).first();
    if (!pl) return errorResponse('Not found', 404);
    if (!canManagePlaylist(pl, user)) return errorResponse('Forbidden', 403);

    const { title, is_public, expires_at } = await request.json();
    const pub = is_public !== undefined
      ? (is_public && isAdminOrCM(user) ? 1 : 0)
      : pl.is_public;
    const exp = expires_at || pl.expires_at;

    await env.DB.prepare(
      'UPDATE playlists SET title=?, is_public=?, expires_at=?, updated_at=? WHERE id=?'
    ).bind(title?.trim() || pl.title, pub, exp, now, plId).run();

    return jsonResponse({ message: 'Updated' });
  }

  // ── DELETE /playlists/:id ─────────────────────────────────────────────────────
  if (plId && !subPath && method === 'DELETE') {
    const pl = await env.DB.prepare('SELECT * FROM playlists WHERE id = ?').bind(plId).first();
    if (!pl) return errorResponse('Not found', 404);
    if (!canManagePlaylist(pl, user)) return errorResponse('Forbidden', 403);

    await env.DB.prepare('DELETE FROM playlists WHERE id = ?').bind(plId).run();
    return jsonResponse({ message: 'Deleted' });
  }

  // ── POST /playlists/:id/items ─────────────────────────────────────────────────
  if (plId && itemMatch && !itemMatch[1] && method === 'POST') {
    const pl = await env.DB.prepare('SELECT * FROM playlists WHERE id = ?').bind(plId).first();
    if (!pl) return errorResponse('Not found', 404);
    if (!canManagePlaylist(pl, user)) return errorResponse('Forbidden', 403);

    const { pdf_detail_id, display_desc, sort_order } = await request.json();
    if (!pdf_detail_id) return errorResponse('pdf_detail_id is required');

    const pdf = await env.DB.prepare('SELECT id, description FROM pdf_detail WHERE id = ?').bind(pdf_detail_id).first();
    if (!pdf) return errorResponse('PDF not found', 404);

    const itemId = newId();
    const desc   = display_desc || pdf.description;

    // Get max sort order
    const { max_order } = await env.DB.prepare(
      'SELECT MAX(sort_order) AS max_order FROM playlist_items WHERE playlist_id = ?'
    ).bind(plId).first();

    await env.DB.prepare(
      'INSERT INTO playlist_items (id, playlist_id, pdf_detail_id, display_desc, sort_order, added_at) VALUES (?,?,?,?,?,?)'
    ).bind(itemId, plId, pdf_detail_id, desc, sort_order ?? ((max_order || 0) + 1), now).run();

    await env.DB.prepare('UPDATE playlists SET updated_at=? WHERE id=?').bind(now, plId).run();

    return jsonResponse({ id: itemId }, 201);
  }

  // ── PUT /playlists/:id/items/:itemId ─────────────────────────────────────────
  if (plId && itemMatch && itemMatch[1] && method === 'PUT') {
    const itemId = itemMatch[1];
    const pl = await env.DB.prepare('SELECT * FROM playlists WHERE id = ?').bind(plId).first();
    if (!pl) return errorResponse('Not found', 404);
    if (!canManagePlaylist(pl, user)) return errorResponse('Forbidden', 403);

    const { display_desc, sort_order } = await request.json();
    const sets = [], vals = [];
    if (display_desc !== undefined) { sets.push('display_desc=?'); vals.push(display_desc); }
    if (sort_order   !== undefined) { sets.push('sort_order=?');   vals.push(sort_order); }
    if (!sets.length) return errorResponse('Nothing to update');
    vals.push(itemId);

    await env.DB.prepare(`UPDATE playlist_items SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();
    return jsonResponse({ message: 'Updated' });
  }

  // ── DELETE /playlists/:id/items/:itemId ──────────────────────────────────────
  if (plId && itemMatch && itemMatch[1] && method === 'DELETE') {
    const itemId = itemMatch[1];
    const pl = await env.DB.prepare('SELECT * FROM playlists WHERE id = ?').bind(plId).first();
    if (!pl) return errorResponse('Not found', 404);
    if (!canManagePlaylist(pl, user)) return errorResponse('Forbidden', 403);

    await env.DB.prepare('DELETE FROM playlist_items WHERE id=? AND playlist_id=?').bind(itemId, plId).run();
    return jsonResponse({ message: 'Removed' });
  }

  return errorResponse('Not found', 404);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function canViewPlaylist(pl, user) {
  return pl.is_public === 1 || pl.owner_id === user.sub || user.role === 'admin';
}

function canManagePlaylist(pl, user) {
  return pl.owner_id === user.sub || user.role === 'admin';
}
