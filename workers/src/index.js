/**
 * ChurchMouse Music – Cloudflare Worker API
 * Entry point: routes all /api/* requests
 */

import { handleAuth }     from './routes/auth.js';
import { handleUsers }    from './routes/users.js';
import { handleMaster }   from './routes/master.js';
import { handlePdf }      from './routes/pdf.js';
import { handleSearch }   from './routes/search.js';
import { handlePlaylists } from './routes/playlists.js';
import { verifyJWT, errorResponse, jsonResponse } from './lib/utils.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age':       '86400',
};

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url    = new URL(request.url);
        //const path = url.pathname.replace(/^\/api/, '');
        let path = url.pathname.replace(/^\/\.api/, '');
    const method = request.method;

    try {
      // ── Public routes (no auth required) ─────────────────────────────────
      if (path.startsWith('/auth/')) {
        return addCors(await handleAuth(request, env, path));
      }

      // ── Protected routes ──────────────────────────────────────────────────
        let user = await verifyJWT(request, env);

        // ✅ Allow PDF view/download to handle auth internally
        if (!user && path.startsWith('/pdf/')) {
            return addCors(await handlePdf(request, env, path, null));
        }

        // ✅ Normal protected routes require auth
        if (!user) return addCors(errorResponse('Unauthorized', 401));


      // Attach user to request context
      request.user = user;

      if (path.startsWith('/users'))     return addCors(await handleUsers(request, env, path, user));
      if (path.startsWith('/master'))    return addCors(await handleMaster(request, env, path, user));
      if (path.startsWith('/pdf'))       return addCors(await handlePdf(request, env, path, user));
      if (path.startsWith('/search'))    return addCors(await handleSearch(request, env, path, user));
      if (path.startsWith('/playlists')) return addCors(await handlePlaylists(request, env, path, user));

      return addCors(errorResponse('Not found', 404));

    } catch (err) {
      console.error('Worker error:', err);
      return addCors(errorResponse('Internal server error', 500));
    }
  }
};

function addCors(response) {
  const r = new Response(response.body, response);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => r.headers.set(k, v));
  return r;
}
