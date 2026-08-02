/**
 * Search route
 * GET /api/search?q=term
 *
 * Searches music_master (title, description, keywords, melody, composer)
 * AND pdf_detail (description, file_name), returns matching master records
 * with their matched child PDFs.
 */

import { jsonResponse, errorResponse } from '../lib/utils.js';

export async function handleSearch(request, env, path, user) {
  if (path !== '/search' || request.method !== 'GET') {
    return errorResponse('Not found', 404);
  }

  const url = new URL(request.url);
  const q   = (url.searchParams.get('q') || '').trim();

  if (!q) return errorResponse('Query parameter q is required');
  if (q.length < 2) return errorResponse('Search term must be at least 2 characters');

  // Sanitize for FTS5 — wrap in quotes for phrase search, fallback to wildcard
  const ftsQuery = `"${q.replace(/"/g, '')}"* OR ${q.replace(/[^a-zA-Z0-9 ]/g, '')}*`;

  // Search master FTS
  const { results: masterMatches } = await env.DB.prepare(`
    SELECT DISTINCT m.id, m.title, m.description, m.keywords, m.melody, m.composer, m.notes, m.created_at
    FROM music_master_fts fts
    JOIN music_master m ON m.id = fts.id
    WHERE music_master_fts MATCH ?
    ORDER BY rank
    LIMIT 50
  `).bind(ftsQuery).all();

  // Search pdf_detail FTS — collect distinct master IDs
  const { results: pdfMatches } = await env.DB.prepare(`
    SELECT DISTINCT p.master_id
    FROM pdf_detail_fts fts
    JOIN pdf_detail p ON p.id = fts.id
    WHERE pdf_detail_fts MATCH ?
    LIMIT 50
  `).bind(ftsQuery).all();

  // Merge master IDs (deduplicated)
  const masterIdSet = new Set([
    ...masterMatches.map(m => m.id),
    ...pdfMatches.map(p => p.master_id)
  ]);

  if (masterIdSet.size === 0) return jsonResponse({ results: [] });

  // For each master, fetch its PDF children
  const results = await Promise.all(
    [...masterIdSet].map(async (masterId) => {
      const master = masterMatches.find(m => m.id === masterId) ||
        await env.DB.prepare(
          'SELECT id, title, description, keywords, melody, composer, notes, created_at FROM music_master WHERE id = ?'
        ).bind(masterId).first();

      const { results: pdfs } = await env.DB.prepare(
        'SELECT id, description, key_signature, file_name, file_size FROM pdf_detail WHERE master_id = ? ORDER BY description, key_signature, file_name'
      ).bind(masterId).all();

      return { ...master, pdfs };
    })
  );

  // Sort: master-level matches first, then by title
  results.sort((a, b) => {
    const aInMaster = masterMatches.some(m => m.id === a.id) ? 0 : 1;
    const bInMaster = masterMatches.some(m => m.id === b.id) ? 0 : 1;
    if (aInMaster !== bInMaster) return aInMaster - bInMaster;
    return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
  });

  return jsonResponse({ results, count: results.length });
}
