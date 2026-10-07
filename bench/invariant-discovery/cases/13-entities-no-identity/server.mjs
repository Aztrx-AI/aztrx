// Bench-harness server for this case: the running app enforces exactly the moves
// src/jobs.js declares. Jobs are addressed by their position in the sorted list.
const NEXT = {
  queued: ["running", "cancelled"],
  running: ["done", "failed"],
  done: [],
  failed: ["queued"],
  cancelled: [],
};
const ORDER = ["queued", "running", "done", "failed", "cancelled"];
const seed = () => ["queued", "running", "done", "failed", "running"].map((status, n) => ({ n, status }));
const sessions = new Map();
const sorted = (list) => [...list].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.n - b.n);
const json = (body) => ({ status: 200, type: "application/json", body: JSON.stringify(body.map((j) => ({ status: j.status }))) });

export default function handle(url) {
  if (url.pathname !== "/api/jobs") return null;
  const sid = url.searchParams.get("sid") ?? "anon";
  if (!sessions.has(sid)) sessions.set(sid, seed());
  const jobs = sessions.get(sid);
  const at = url.searchParams.get("at");
  const to = url.searchParams.get("to");
  const job = at !== null ? sorted(jobs)[Number(at)] : null;
  if (job && to && NEXT[job.status]?.includes(to)) job.status = to;
  return json(sorted(jobs));
}
