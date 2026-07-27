async function reservePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('reserved') });
  const port = server.port;
  await server.stop(true);
  if (!port) throw new Error('Bun did not allocate a port');
  return port;
}

async function waitForHealth(url: URL, process: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`wrangler exited during startup: ${process.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Workerd is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error('Timed out waiting for local workerd');
}

const port = await reservePort();
const origin = new URL(`http://127.0.0.1:${port}`);
const cwd = new URL('..', import.meta.url).pathname;
const wrangler = Bun.spawn(
  [
    'bunx',
    'wrangler',
    'dev',
    '--local',
    '--config',
    'wrangler.jsonc',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--var',
    'AUTH_ENABLED:false',
    '--var',
    'AUTH_STRATEGY:none',
  ],
  { cwd, stdout: 'pipe', stderr: 'pipe' },
);

try {
  await waitForHealth(new URL('/health', origin), wrangler);
  const client = Bun.spawn(
    ['bun', 'run', 'tests/workerd-client.ts', new URL('/mcp', origin).href],
    { cwd, stdout: 'inherit', stderr: 'inherit' },
  );
  const exitCode = await client.exited;
  if (exitCode !== 0) throw new Error(`Workerd client failed with exit ${exitCode}`);
  console.log('Local workerd modern+legacy smoke passed');
} finally {
  wrangler.kill('SIGTERM');
  await Promise.race([wrangler.exited, Bun.sleep(3_000)]);
}
