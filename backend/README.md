# backend (Phase 4 — not started)

Optional local API (Fastify + SQLite, port 3004, ciphertext only). Per the PRD, this is
built only after the Phase 2 go/no-go gate returns **go**. See `docs/adr/0002-poc-result.md`.

The `backend` service (container name `backend`) in `docker-compose.yml` sits behind the
`backend` profile, so `docker compose up` does not try to build it. Start it in Phase 4 with:

```bash
docker compose --profile backend up -d --build backend
```
