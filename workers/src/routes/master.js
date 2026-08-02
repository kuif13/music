/**
 * Music Master (parent) routes
 * GET    /api/master          – list all (paginated)
 * POST   /api/master          – create (CM or admin)
 * GET    /api/master/:id      – get one + children
 * PUT    /api/master/:id      – update (CM or admin)
 * DELETE /api/master/:id      – delete (CM or admin)
 */

import {
  jsonResponse, errorResponse,
  isAdminOrCM, newId
} from '../lib/utils.js';

export async function handleMaster(request, env, path, user) {
  const method  = request.method;
  const idMatch = path.match(/^\/master\/([^/]+)/);
  const id      = idMatch ? idMatch[1] : null;

  // ── GET /master  (list, paginated) ───────────────────────────────────────────
  if (!id && method === 'GET') {
    const url    = new URL(request.url);
    const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '50'), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0');
      const sort = url.searchParams.get('sort') === 'created' ? 'created' : 'title';

      const orderClause = sort === 'created'
          ? 'm.created_at DESC'
          : `TRIM(m.title, '0123456789'), CAST(REPLACE(m.title, TRIM(m.title, '0123456789'), '') AS INTEGER)`;

      const { results } = await env.DB.prepare(
          `SELECT m.*,
                (SELECT COUNT(*) FROM pdf_detail p WHERE p.master_id = m.id) AS pdf_count
         FROM music_master m
         ORDER BY ${orderClause}
         LIMIT ? OFFSET ?`
      ).bind(limit, offset).all();

      const { total } = await env.DB.prepare('SELECT COUNT(*) AS total FROM music_master').first();
      return jsonResponse({ results, total, limit, offset });
  }
  

  // ── POST /master (create) ────────────────────────────────────────────────────
  if (!id && method === 'POST') {
    if (!isAdminOrCM(user)) return errorResponse('Forbidden', 403);

    const { title, description, keywords, melody, composer, notes } = await request.json();
    if (!title?.trim()) return errorResponse('Title is required');

    const newMasterId = newId();
    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(
      `INSERT INTO music_master (id, title, description, keywords, melody, composer, notes, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      newMasterId,
      title.trim(),
      description || null,
      keywords    || null,
      melody      || null,
      composer    || null,
      notes       || null,
      user.sub,
      now, now
    ).run();

    return jsonResponse({ id: newMasterId }, 201);
  }

  // ── GET /master/:id ──────────────────────────────────────────────────────────
  if (id && method === 'GET') {
    const master = await env.DB.prepare('SELECT * FROM music_master WHERE id = ?').bind(id).first();
    if (!master) return errorResponse('Not found', 404);

    const { results: pdfs } = await env.DB.prepare(
      'SELECT id, description, key_signature, file_name, file_size, created_at FROM pdf_detail WHERE master_id = ? ORDER BY description, key_signature, file_name'
    ).bind(id).all();

    return jsonResponse({ ...master, pdfs });
  }

  // ── PUT /master/:id ──────────────────────────────────────────────────────────
  if (id && method === 'PUT') {
    if (!isAdminOrCM(user)) return errorResponse('Forbidden', 403);

    const { title, description, keywords, melody, composer, notes } = await request.json();
    if (!title?.trim()) return errorResponse('Title is required');

    const row = await env.DB.prepare('SELECT id FROM music_master WHERE id = ?').bind(id).first();
    if (!row) return errorResponse('Not found', 404);

    await env.DB.prepare(
      `UPDATE music_master SET title=?, description=?, keywords=?, melody=?, composer=?, notes=?, updated_at=? WHERE id=?`
    ).bind(
      title.trim(),
      description || null,
      keywords    || null,
      melody      || null,
      composer    || null,
      notes       || null,
      Math.floor(Date.now() / 1000),
      id
    ).run();

    return jsonResponse({ message: 'Updated' });
  }

  // ── DELETE /master/:id ───────────────────────────────────────────────────────
  if (id && method === 'DELETE') {
    if (!isAdminOrCM(user)) return errorResponse('Forbidden', 403);

    // Get all child R2 keys to delete from object storage
    const { results: pdfs } = await env.DB.prepare(
      'SELECT r2_key FROM pdf_detail WHERE master_id = ?'
    ).bind(id).all();

    // Delete from R2
    await Promise.all(pdfs.map(p => env.PDF_BUCKET.delete(p.r2_key)));

    // D1 cascade will remove pdf_detail rows
    await env.DB.prepare('DELETE FROM music_master WHERE id = ?').bind(id).run();

    return jsonResponse({ message: 'Deleted' });
  }

  return errorResponse('Not found', 404);
}
