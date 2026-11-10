import { existsSync } from 'node:fs';
import { EXTENSION_DIR } from './fixtures.js';
import { BASE_URL } from './playwright.config.js';

export default async function globalSetup(): Promise<void> {
  if (!existsSync(`${EXTENSION_DIR}/manifest.json`)) {
    throw new Error(`Extension not built at ${EXTENSION_DIR}. Run: npm run build -w extension`);
  }
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error(String(res.status));
  } catch (e) {
    throw new Error(`Test server not reachable at ${BASE_URL} (${String(e)}). Run: docker compose up -d --build app`, {
      cause: e,
    });
  }
}
