import { buildApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '3003', 10);
const host = process.env.HOST ?? '0.0.0.0';

const app = buildApp({ logger: process.env.LOG !== '0' });

const shutdown = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen({ port, host }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
