# Deploying aztrx.app

The repo is a small monorepo: the **CLI** at the root, this **Next.js landing
page** in `web/`. It lives at `github.com/Aztrx-AI/aztrx`, and `aztrx.app`
already serves an earlier deploy of this page — pushing `web/` to `main` is how
the next version reaches it.

## 1. Push to GitHub

`origin` is already the project repo, so there is nothing to add:

```bash
git push origin main
```

## 2. Connect Vercel

Already linked — `web/.vercel/project.json` names the `aztrx` project. These are
the settings it was created with, for reference:

1. Vercel → **Add New Project** → import the repo.
2. **Root Directory → `web/`** (critical — the repo root is the CLI package,
   not a web framework).
3. Framework: auto-detected **Next.js**. Build command `next build` (or
   `npm run build`), output `.next`. Leave the defaults.

## 3. Point the domain

1. Project → **Settings → Domains** → add `aztrx.app` (and `www.aztrx.app`).
2. Update DNS if Vercel asks (A record `76.76.21.21`, CNAME `cname.vercel-dns.com`).

## Local preview

```bash
cd web
npm install
npm run dev        # http://localhost:3000
npm run build      # production build (.next)
```
