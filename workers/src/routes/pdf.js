/**
 * PDF Detail (child) routes
 * GET    /api/pdf/:id/view      – stream PDF from R2 (inline)
 * GET    /api/pdf/:id/download  – stream PDF as attachment
 * POST   /api/pdf               – upload new PDF detail
 * PUT    /api/pdf/:id           – update metadata (no re-upload)
 * DELETE /api/pdf/:id           – delete detail + R2 object
 */


import { verifyJWT } from '../lib/utils.js';


import {
  jsonResponse, errorResponse,
  isAdminOrCM, newId
} from '../lib/utils.js';

export async function handlePdf(request, env, path, user) {
    const method = request.method;

  /*  if (path.includes('/pdf')) {
        return new Response('✅ PDF ROUTE HIT', { status: 200 });
    }
  */


    // ✅ MUST BE INSIDE FUNCTION
    let effectiveUser = user;

    console.log('Token verification checking')

    if (!effectiveUser) {
        const url = new URL(request.url);
        const token = url.searchParams.get('token');

        if (token) {
            try {
                const headers = new Headers(request.headers);
                headers.set('Authorization', 'Bearer ' + token);

                const newRequest = new Request(request, { headers });

                effectiveUser = await verifyJWT(newRequest, env);
            } catch (e) {
                console.log('Token verification failed:', e.message);
            }
        }
    }
    

    // ── GET /pdf/:id/view ─────────────────────
    const serveMatch = path.match(/^\/pdf\/([^/]+)\/(view|download)$/);
    if (serveMatch && method === 'GET') {
        if (!effectiveUser) return errorResponse('Unauthorized', 401);

        const [, pdfId, mode] = serveMatch;

        const row = await env.DB.prepare(
            'SELECT r2_key, file_name FROM pdf_detail WHERE id = ?'
        ).bind(pdfId).first();

        if (!row) return errorResponse('Not found', 404);

        const obj = await env.PDF_BUCKET.get(row.r2_key);
        if (!obj) return errorResponse('File not found in storage', 404);

        const disposition = mode === 'download'
            ? `attachment; filename="${row.file_name}"`
            : `inline; filename="${row.file_name}"`;

        return new Response(obj.body, {
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': disposition,
                'Cache-Control': 'private, max-age=3600',
            }
        });
    }





  // ── POST /pdf (upload) ───────────────────────────────────────────────────────
  // Expects multipart/form-data: master_id, description, key_signature, file (PDF)
  if (path === '/pdf' && method === 'POST') {
    if (!isAdminOrCM(user)) return errorResponse('Forbidden', 403);

    const formData = await request.formData();
    const masterId    = formData.get('master_id');
    const description = formData.get('description');
    const keySignature = formData.get('key_signature') || null;
    const file        = formData.get('file');

    if (!masterId || !description || !file) {
      return errorResponse('master_id, description and file are required');
    }

    // Validate master exists
    const master = await env.DB.prepare('SELECT id FROM music_master WHERE id = ?').bind(masterId).first();
    if (!master) return errorResponse('Master record not found', 404);

    if (file.type !== 'application/pdf') return errorResponse('Only PDF files are accepted');
    const MAX_SIZE = 20 * 1024 * 1024; // 20 MB
    if (file.size > MAX_SIZE) return errorResponse('File exceeds 20 MB limit');

    const pdfId   = newId();
    const r2Key   = `pdfs/${masterId}/${pdfId}/${file.name}`;
    const now     = Math.floor(Date.now() / 1000);

    // Upload to R2
    await env.PDF_BUCKET.put(r2Key, file.stream(), {
      httpMetadata: { contentType: 'application/pdf' },
      customMetadata: { fileName: file.name, uploadedBy: user.sub }
    });

    await env.DB.prepare(
      `INSERT INTO pdf_detail (id, master_id, description, key_signature, file_name, r2_key, file_size, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      pdfId, masterId,
      description.trim(),
      keySignature,
      file.name,
      r2Key,
      file.size,
      user.sub, now, now
    ).run();

    return jsonResponse({ id: pdfId, file_name: file.name, file_size: file.size }, 201);
  }

  // ── PUT /pdf/:id (update metadata only) ──────────────────────────────────────
  const idMatch = path.match(/^\/pdf\/([^/]+)$/);
  if (idMatch && method === 'PUT') {
    if (!isAdminOrCM(user)) return errorResponse('Forbidden', 403);

    const pdfId = idMatch[1];
    const { description, key_signature } = await request.json();
    if (!description?.trim()) return errorResponse('Description is required');

    const row = await env.DB.prepare('SELECT id FROM pdf_detail WHERE id = ?').bind(pdfId).first();
    if (!row) return errorResponse('Not found', 404);

    await env.DB.prepare(
      'UPDATE pdf_detail SET description=?, key_signature=?, updated_at=? WHERE id=?'
    ).bind(description.trim(), key_signature || null, Math.floor(Date.now() / 1000), pdfId).run();

    return jsonResponse({ message: 'Updated' });
  }

  // ── DELETE /pdf/:id ───────────────────────────────────────────────────────────
  if (idMatch && method === 'DELETE') {
    if (!isAdminOrCM(user)) return errorResponse('Forbidden', 403);

    const pdfId = idMatch[1];
    const row = await env.DB.prepare('SELECT r2_key FROM pdf_detail WHERE id = ?').bind(pdfId).first();
    if (!row) return errorResponse('Not found', 404);

    await env.PDF_BUCKET.delete(row.r2_key);
    await env.DB.prepare('DELETE FROM pdf_detail WHERE id = ?').bind(pdfId).run();

    return jsonResponse({ message: 'Deleted' });
  }

  return errorResponse('Not found', 404);
}
