# LaTeX Editor — Backend

> REST API + real-time WebSocket server for the collaborative LaTeX editor.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![Hono](https://img.shields.io/badge/Hono-4-E36002?logo=hono)](https://hono.dev)
[![Prisma](https://img.shields.io/badge/Prisma-5-2D3748?logo=prisma)](https://www.prisma.io)

Built with **Hono · Node.js · Prisma · PostgreSQL (Supabase)**, designed to deploy on **Render** (native Node runtime, no Docker).

> **Frontend repository:** [`latex-editor-frontend`](https://github.com/tanguy-kabore/latex-editor-frontend)

---

## Table of Contents

- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [API Reference](#api-reference)
- [Compilation Flow](#compilation-flow)
- [Prerequisites](#prerequisites)
- [Local Development](#local-development)
- [Environment Variables](#environment-variables)
- [Supabase Setup](#supabase-setup)
- [Deployment](#deployment-render)
- [Design Decisions](#non-obvious-design-decisions)
- [Contributing](#contributing)
- [License](#license)

---

## Architecture

```
src/
├── index.ts                  # HTTP server + WebSocket upgrade handler
├── middleware/
│   └── auth.ts               # JWT Bearer authentication middleware
├── routes/
│   ├── auth.ts               # Register, login, current user
│   ├── projects.ts           # Project CRUD, share links, members, archive, trash
│   ├── files.ts              # File CRUD per project
│   ├── compile.ts            # Server-side pdflatex compilation + Supabase PDF storage
│   ├── templates.ts          # Document template list
│   ├── chat.ts               # Project team chat messages
│   ├── git.ts                # GitHub and GitLab push / pull via API
│   ├── export.ts             # Pandoc-based conversion (HTML, DOCX, Markdown)
│   └── arxiv.ts              # arXiv compatibility analysis + tar.gz archive
├── ws/
│   └── yjs.ts                # Yjs y-websocket room handler
└── lib/
    ├── prisma.ts             # Prisma singleton
    ├── supabase.ts           # Supabase admin client (Storage)
    └── templates.ts          # LaTeX document template content
prisma/
└── schema.prisma
render.yaml                   # Render deployment config
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| HTTP framework | Hono 4 |
| Runtime | Node.js ≥ 20 |
| Language | TypeScript 5 |
| ORM | Prisma 5 |
| Database | PostgreSQL via Supabase |
| File storage | Supabase Storage |
| Auth | JWT (jsonwebtoken) |
| Real-time | Yjs y-websocket |
| LaTeX (server-side) | pdflatex (TeX Live, Render build) |
| Export | Pandoc |

---

## API Reference

### Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | — | Create account |
| POST | `/api/auth/login` | — | Login, returns JWT |
| GET | `/api/auth/me` | ✓ | Current user info |

### Projects

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/projects` | ✓ | List projects (`?filter=all\|mine\|shared\|archived\|trashed`) |
| POST | `/api/projects` | ✓ | Create project (template or ZIP import) |
| GET | `/api/projects/:id` | ✓ | Get project metadata |
| PATCH | `/api/projects/:id` | ✓ | Rename, archive, restore, soft-delete |
| DELETE | `/api/projects/:id` | ✓ | Permanently delete (owner only) |
| POST | `/api/projects/:id/fork` | ✓ | Fork project |
| POST | `/api/projects/:id/share` | ✓ | Generate read-only share link (30-day JWT) |
| POST | `/api/projects/:id/members` | ✓ | Add member by email |
| PATCH | `/api/projects/:id/members/:uid` | ✓ | Change member role |
| DELETE | `/api/projects/:id/members/:uid` | ✓ | Remove member |

### Files

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/projects/:id/files` | ✓ | List files (metadata only) |
| GET | `/api/projects/:id/files-full` | ✓ | List files with content |
| POST | `/api/projects/:id/files` | ✓ | Create file |
| GET | `/api/projects/:id/files/:fid` | ✓ | Get file content |
| PUT | `/api/projects/:id/files/:fid` | ✓ | Save file content |
| PATCH | `/api/projects/:id/files/:fid` | ✓ | Rename or set as main |
| DELETE | `/api/projects/:id/files/:fid` | ✓ | Delete file |
| GET | `/api/projects/:id/files/:fid/history` | ✓ | File revision history |
| POST | `/api/projects/:id/files/:fid/restore/:rev` | ✓ | Restore a revision |

### Compilation

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/compile/:projectId` | ✓ | Compile with pdflatex, upload PDF to Supabase Storage |

> **Note:** The frontend compiles in-browser via busytex (WASM pdflatex). This server-side route is a fallback / alternative compilation path.

### Chat

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/projects/:id/chat` | ✓ | Fetch messages (`?cursor=<ISO date>&limit=50`) |
| POST | `/api/projects/:id/chat` | ✓ | Post message |

### Git

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/projects/:id/git/push` | ✓ | Push all files to GitHub or GitLab |
| POST | `/api/projects/:id/git/pull` | ✓ | Pull `.tex/.bib` files from GitHub or GitLab |

Supported providers: `github`, `gitlab` (self-hosted or gitlab.com). PAT tokens are passed per-request and never stored.

### Export

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/export/:projectId` | ✓ | Convert to `html`, `docx`, or `markdown` via Pandoc |

### arXiv

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/arxiv/:projectId/analyse` | ✓ | Compatibility report (unsupported packages, missing files, comment count) |
| POST | `/api/arxiv/:projectId/archive` | ✓ | Build a POSIX ustar tar.gz archive (`?cleanComments=true` optional) |

### Templates

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/templates` | — | List available document templates |

### WebSocket

| Path | Auth | Description |
|------|------|-------------|
| `WS /ws/:projectId?token=<JWT>` | ✓ | Yjs CRDT collaboration room |

### Utility

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Health check |

---

## Compilation Flow

```
POST /api/compile/:projectId
  │
  ├─ Verify membership (OWNER or EDITOR required)
  ├─ Fetch all project files from database
  ├─ mkdirSync /tmp/<uuid>/
  ├─ Write each file to tmp dir
  ├─ Create CompilationJob record (status: RUNNING)
  ├─ spawn pdflatex -interaction=nonstopmode -halt-on-error main.tex
  │    └─ Timeout: SIGTERM @ 30s, SIGKILL @ 32s
  ├─ Parse .log for errors and LaTeX/Package warnings
  ├─ On success (exitCode 0):
  │    ├─ Read PDF buffer
  │    ├─ Upload to Supabase Storage: pdfs/<projectId>/<jobId>.pdf
  │    └─ Create signed URL (1 hour)
  ├─ Update CompilationJob (status: SUCCESS | ERROR | TIMEOUT)
  └─ rmSync /tmp/<uuid>/ (always, in finally block)
```

---

## Prerequisites

- **Node.js** ≥ 20
- **npm** ≥ 9
- A [Supabase](https://supabase.com) project (free tier works)
- *(Optional, for server-side compilation)* `pdflatex` installed locally
- *(Optional, for export)* `pandoc` installed locally

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env

# 3. Generate Prisma client
npx prisma generate

# 4. Run migrations
npx prisma migrate dev

# 5. Start dev server
npm run dev
```

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | Supabase pooler URL (pgBouncer, port 6543) |
| `DIRECT_URL` | Supabase direct URL (port 5432, for migrations) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase `service_role` key (bypasses RLS) |
| `JWT_SECRET` | Long random string for signing JWTs |
| `FRONTEND_URL` | Frontend origin (Vercel URL) — used for CORS and share links |
| `PORT` | Server port (Render sets this automatically) |

---

## Supabase Setup

1. Create a project at [supabase.com](https://supabase.com)
2. **Storage → New bucket** → name `pdfs` → **Private** (no public access)
3. **Settings → Database** → copy connection strings:
   - Transaction pooler (port 6543) → `DATABASE_URL`
   - Direct connection (port 5432) → `DIRECT_URL`
4. **Settings → API** → copy Project URL → `SUPABASE_URL`
5. **Settings → API** → copy `service_role` key → `SUPABASE_SERVICE_KEY`

---

## Deployment (Render)

1. Push this repository to GitHub or GitLab
2. Go to [render.com](https://render.com) → **New Web Service** → connect the repo
3. **Environment**: `Node` (not Docker)
4. **Build command**: as defined in `render.yaml` — installs TeX Live + Pandoc, then builds the app
5. **Start command**: `node dist/index.js`
6. Add all environment variables listed in `.env.example`

> The first build installs TeX Live (~800 MB) and takes ~10 minutes. Subsequent builds use Render's build cache (~2–3 min).

---

## Non-Obvious Design Decisions

> These notes exist to prevent future confusion for contributors.

- **Yjs `noServer` mode** — the WebSocket server is attached to the same HTTP server via the `upgrade` event, avoiding a second port.
- **JWT parsed on upgrade** — the WebSocket handler verifies the `?token=` query param using `jsonwebtoken.verify` before handing off to the Yjs room, so unauthenticated WS connections are rejected at the OS level.
- **Git PAT never persisted** — tokens are passed per-request in the JSON body and used immediately; never written to the database.
- **arXiv tar.gz in pure Node** — the archive is built manually in POSIX ustar format without any native tar binary, so it works on any Node runtime regardless of OS.
- **Pandoc checked at runtime** — the export route checks pandoc availability before processing and returns a `503` with an actionable message if it is missing, rather than a generic 500.

---

## Contributing

Contributions are welcome!

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit your changes: `git commit -m 'feat: add my feature'`
4. Push to the branch: `git push origin feat/my-feature`
5. Open a Pull Request

Please add or update tests where relevant. By contributing, you agree that your code will be released under the AGPL-3.0 license.

---

## License

This project is licensed under the **GNU Affero General Public License v3.0**.

See [LICENSE](LICENSE) for the full text.

Key points:
- ✅ Free to use, modify, and self-host
- ⚠️ If you deploy a modified version as a public service, you **must** publish the source code (network-use copyleft clause)
- ❌ Cannot be relicensed as proprietary software

Copyright © 2026 LaTeX Editor Contributors
