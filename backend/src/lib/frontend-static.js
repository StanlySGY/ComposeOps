/** Register the same static-file boundary for production and loopback tests. */
export async function registerFrontendStatic(fastify, root) {
  const fastifyStatic = (await import('@fastify/static')).default;
  // The plugin defaults to allowing dotfiles. Build output must not publish
  // accidentally copied .env/.git data, including precompressed variants.
  await fastify.register(fastifyStatic, { root, prefix: '/', preCompressed: true, dotfiles: 'ignore' });
  fastify.setNotFoundHandler((request, reply) => {
    let pathname;
    try { pathname = decodeURIComponent(request.url.split('?')[0]); }
    catch { return reply.code(404).send({ error: 'not_found' }); }
    if (pathname.startsWith('/api') || pathname.startsWith('/ws') || pathname.split('/').some(part => part.startsWith('.'))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.sendFile('index.html');
  });
}
