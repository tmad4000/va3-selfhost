// Dedicated native-client entry point. Isolation is set before app imports;
// no browser/admin API, agent sweep, self-update loop or web UI is started.
import { createServer } from 'node:http';
process.env.VA3_SELF_HOST = '1';
const { env } = await import('./env.js');
const { handleDrive, initDrive } = await import('./drive/routes.js');
const host = env('HOST', '127.0.0.1');
let port = Number(env('PORT', '9471'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/drive/') && await handleDrive(req, res, url)) return;
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end('{"error":"Native drive API only"}');
  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end('{"error":"Request failed"}');
  }
});
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && port < 65535) { port++; server.listen(port, host); }
  else { console.error('Self-host server could not listen'); process.exitCode = 1; }
});
server.once('listening', () => {
  initDrive({ port });
  console.log(`VA3 standalone server listening at http://localhost:${port}/ (loopback by default; configure private HTTPS for your phone)`);
});
server.listen(port, host);
