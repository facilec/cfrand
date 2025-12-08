import { generateEntropyResponse } from './entropy.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (url.pathname !== '/api/random') {
      return new Response('Not Found', { status: 404 });
    }

    const { status, body } = await generateEntropyResponse(env, { logger: console });
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      },
    });
  },
};
