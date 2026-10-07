// Bench-harness server for this case: the running app. Each browser session
// gets its own five jobs. It enforces exactly the moves src/jobs.js declares:
// a failed job may be retried (-> queued) and nothing else.
const NEXT = {
  queued: ["running", "cancelled"],
  running: ["done", "failed"],
  done: [],
  failed: ["queued"],
  cancelled: [],
};
const ORDER = ["queued", "running", "done", "failed", "cancelled"];
const seed = () => [
  { id: "J-101", status: "queued" },
  { id: "J-102", status: "running" },
  { id: "J-103", status: "done" },
  { id: "J-104", status: "failed" },
  { id: "J-105", status: "running" },
];
const sessions = new Map();
const sorted = (list) => [...list].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.id.localeCompare(b.id));
const json = (body) => ({ status: 200, type: "application/json", body: JSON.stringify(body) });

export default function handle(url) {
  if (url.pathname !== "/api/jobs") return null;
  const sid = url.searchParams.get("sid") ?? "anon";
  if (!sessions.has(sid)) sessions.set(sid, seed());
  const jobs = sessions.get(sid);
  const id = url.searchParams.get("id");
  const to = url.searchParams.get("to");
  const job = id ? jobs.find((j) => j.id === id) : null;
  if (job && to && NEXT[job.status]?.includes(to)) job.status = to;
  return json(sorted(jobs));
}
