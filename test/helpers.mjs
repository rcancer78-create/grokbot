import { createServer } from '../server.mjs';

export async function serve(t, options = {}) {
  const server = createServer({ token: '', ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t?.after?.(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

export async function serveServer(t, options = {}) {
  const server = createServer({
    token: '',
    warn: () => {},
    modelAliases: '',
    estimateUsage: false,
    queueLimit: 4,
    queueWaitMs: 30000,
    askFn: async () => ({ text: 'hello' }),
    ...options,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t?.after?.(() => server.shutdown({ timeoutMs: 1000 }));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
