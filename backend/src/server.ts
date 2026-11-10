import { buildApp } from './app.js';
import { openDb } from './db.js';

const port = Number.parseInt(process.env.PORT ?? '3004', 10);
const secret = process.env.API_SECRET ?? '';
if (secret.length < 32) {
  console.error('[backend] API_SECRET is missing or shorter than 32 characters (see .env)');
  process.exit(1);
}
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const db = openDb(process.env.DATABASE_PATH ?? './data/sessions.sqlite');
const app = buildApp({
  db,
  secret,
  // Docker publishes 127.0.0.1:<port> only; these are the Host headers the extension sends.
  allowedHosts: list(process.env.ALLOWED_HOSTS).length ? list(process.env.ALLOWED_HOSTS) : [`127.0.0.1:${port}`, `localhost:${port}`],
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),
  logger: process.env.LOG !== '0',
});

const shutdown = async (): Promise<void> => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Inside the container it binds 0.0.0.0; the host only publishes it on loopback (docker-compose.yml).
app.listen({ port, host: process.env.HOST ?? '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
