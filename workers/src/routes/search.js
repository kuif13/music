/**
 * Search route
 * GET /api/search?q=term
 *
 * Searches music_master (title, description, keywords, melody, composer)
 * AND pdf_detail (description, file_name), returns matching master records
 * with their matched child PDFs.
 */

import { jsonResponse, errorResponse } from '../lib/utils.js';

/**
 * How well a title matches the search term. Lower sorts first.
 *
 *   0  the title is exactly the term
 *   1  the title begins with the term
 *   2  the term appears somewhere in the title
 *   3  the term is not in the title at all
 *
 * Case and runs of whitespace are ignored. Exported so it can be tested
 * without standing up a database.
 */
export function titleRank(title, needle) {
  const t = (title || '').trim().toLowerCase().replace(/\s+/g, ' ');

  if (t === needle)         return 0;
  if (t.startsWith(needle)) return 1;
  if (t.includes(needle))   return 2;

  return 3;
}

export async function handleSearch(request, env, path, user) {
  if (path !== '/search' || request.method !== 'GET') {
    return errorResponse('Not found', 404);
  }

  const url = new URL(request.url);
  const q   = (url.searchParams.get('q') || '').trim();

  if (!q) return errorResponse('Query parameter q is required');
  if (q.length < 2) return errorResponse('Search term must be at least 2 characters');

  // Sanitize for FTS5 — wrap in quotes for phrase search, fallback to wildcard.
  // The fallback is dropped when the term has no alphanumerics left, since a
  // bare "*" is not a valid FTS expression.
  const fallback = q.replace(/[^a-zA-Z0-9 ]/g, '').trim();
  const ftsQuery = fallback
    ? `"${q.replace(/"/g, '')}"* OR ${fallback}*`
    : `"${q.replace(/"/g, '')}"*`;

  // Look titles up directly, independently of FTS.
  //
  // FTS gives recall but does not favour titles, and a phrase-prefix match
  // treats "Ps 1" as matching "Ps 10", "Ps 100" and "Ps 119" just as strongly.
  // With 60-odd such titles the one the user actually typed can be pushed past
  // the LIMIT below and vanish from the results entirely. Fetching title
  // matches separately guarantees they are present; shortest first, so an exact
  // title always survives the limit.
  const likeTerm = q.replace(/[\\%_]/g, '\\$&');

  const { results: titleMatches } = await env.DB.prepare(`
    SELECT id, title, description, keywords, melody, composer, notes, created_at
    FROM music_master
    WHERE title = ? COLLATE NOCASE
       OR title LIKE ? ESCAPE '\\'
    ORDER BY LENGTH(title), title
    LIMIT 25
  `).bind(q, likeTerm + '%').all();

  // FTS can throw on an expression the tokenizer reduces to nothing. Title
  // results are already in hand, so degrade to those rather than 500.
  let masterMatches = [];
  let pdfMatches    = [];

  try {
    ({ results: masterMatches } = await env.DB.prepare(`
      SELECT DISTINCT m.id, m.title, m.description, m.keywords, m.melody, m.composer, m.notes, m.created_at
      FROM music_master_fts fts
      JOIN music_master m ON m.id = fts.id
      WHERE music_master_fts MATCH ?
      ORDER BY rank
      LIMIT 50
    `).bind(ftsQuery).all());

    ({ results: pdfMatches } = await env.DB.prepare(`
      SELECT DISTINCT p.master_id
      FROM pdf_detail_fts fts
      JOIN pdf_detail p ON p.id = fts.id
      WHERE pdf_detail_fts MATCH ?
      LIMIT 50
    `).bind(ftsQuery).all());
  } catch (err) {
    console.error('FTS query failed for', JSON.stringify(ftsQuery), err);
  }

  // Merge master IDs (deduplicated)
  const masterIdSet = new Set([
    ...titleMatches.map(m => m.id),
    ...masterMatches.map(m => m.id),
    ...pdfMatches.map(p => p.master_id)
  ]);

  if (masterIdSet.size === 0) return jsonResponse({ results: [] });

  // Rows already fetched by either query, so the per-id lookup below only runs
  // for masters reached solely through a PDF match.
  const knownMasters = new Map(
    [...masterMatches, ...titleMatches].map(m => [m.id, m])
  );

  // For each master, fetch its PDF children
  const results = await Promise.all(
    [...masterIdSet].map(async (masterId) => {
      const master = knownMasters.get(masterId) ||
        await env.DB.prepare(
          'SELECT id, title, description, keywords, melody, composer, notes, created_at FROM music_master WHERE id = ?'
        ).bind(masterId).first();

      const { results: pdfs } = await env.DB.prepare(
        'SELECT id, description, key_signature, file_name, file_size FROM pdf_detail WHERE master_id = ? ORDER BY description, key_signature, file_name'
      ).bind(masterId).all();

      return { ...master, pdfs };
    })
  );

  // Rank by how well the *title* matches, before anything else. Searching
  // "Ps 1" should surface the piece called "Ps 1" ahead of "Ps 100", and both
  // ahead of a record that merely mentions the term in its keywords or in the
  // description of one of its PDFs.
  const needle = q.toLowerCase().replace(/\s+/g, ' ');
  const masterMatchIds = new Set(masterMatches.map(m => m.id));

  const rankOf = (r) => {
    const tr = titleRank(r.title, needle);
    if (tr < 3) return tr;

    return masterMatchIds.has(r.id) ? 3          // matched another master field
                                    : 4;         // matched only a child PDF
  };

  results.sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra - rb;

    // Numeric collation so "Ps 2" precedes "Ps 10" rather than following it.
    return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
  });

  return jsonResponse({ results, count: results.length });
}
