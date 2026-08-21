# Deploying aztrx.app

The repo is a small monorepo: the **CLI** at the root, this **Next.js landing
page** in `web/`. There is no git remote yet, and `aztrx.app` currently serves
the retired focus-tracker (Vercel deploys it from a separate `aztrx` GitHub
repo). Deploying this page takes over the domain.

## 1. Push to GitHub

The repo has no remote. Create one and push:

```bash
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

> Naming note: the retired tracker already owns `DanisChaparov/aztrx`. Either
> rename that repo (e.g. `aztrx-tracker`) or name this one differently before
> pushing, so GitHub doesn't reject the push.

## 2. Connect Vercel

1. Vercel → **Add New Project** → import the repo.
2. **Root Directory → `web/`** (critical — the repo root is the CLI package,
   not a web framework).
3. Framework: auto-detected **Next.js**. Build command `next build` (or
   `npm run build`), output `.next`. Leave the defaults.

## 3. Point the domain

1. Project → **Settings → Domains** → add `aztrx.app` (and `www.aztrx.app`).
2. Update DNS if Vercel asks (A record `76.76.21.21`, CNAME `cname.vercel-dns.com`).
3. This supersedes the tracker's deploy at `aztrx.app` — the tracker code stays
   archived in git; only its live site swaps.

## 4. Fix the Supabase redirects (still pending)

The Supabase project's Auth **Site URL / Redirect URLs** still point at the dead
`stt-opal.vercel.app`. Update them to `https://aztrx.app` (dashboard →
Authentication → URL Configuration).

## Local preview

```bash
cd web
npm install
npm run dev        # http://localhost:3000
npm run build      # production build, static output
```
