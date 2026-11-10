# backend — optional local API (Phase 4, ADR 0004)

Keeps an extra **encrypted** copy of SessionWoy's saved logins. The extension encrypts everything
(AES-256-GCM, key from your passphrase) before sending; this server only ever stores ciphertext,
the KDF parameters, and the session list (names/colors).

```bash
# .env must contain API_SECRET (openssl rand -hex 32)
docker compose --profile backend up -d --build backend   # container "backend", 127.0.0.1:3004 only
curl http://127.0.0.1:3004/health
```

In the extension: side panel → **Backend** → URL `http://127.0.0.1:3004` + the `API_SECRET` value →
**Connect** (Chrome asks for access to that address).

- `GET /health` (no secret) · `GET /v1/vault` · `PUT /v1/vault/header` · `PUT|DELETE /v1/vault/sessions/:id`
  · `DELETE /v1/vault` · `PUT /v1/sessions`
- Every `/v1` call needs `Authorization: Bearer <API_SECRET>`. Requests with a website `Origin` (403) or a
  non-loopback `Host` (421) are refused. Optional `BACKEND_ALLOWED_ORIGINS=chrome-extension://<id>` pins the extension.
- Data: SQLite in the `session_data` volume; schema in `migrations/`.
- Connecting a second device never overwrites the backend: it offers **Restore from backend** or an explicit
  **Replace backend with this device**.

Development: `npm run dev -w backend`, `npm test -w backend`, `npm run build -w backend`.
