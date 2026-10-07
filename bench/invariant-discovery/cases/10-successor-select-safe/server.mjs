// Bench-harness server for this case: the running app enforces exactly the
// moves src/jobs.js declares. Jobs are kept per id.
const NEXT = {
  queued: ["running", "cancelled"],
  running: ["done", "failed"],
  done: [],
  failed: ["queued"],
  cancelled: [],
};
const jobs = new Map();
const json = (body) => ({ status: 200, type: "application/json", body: JSON.stringify(body) });

export default function handle(url) {
  if (url.pathname !== "/api/job") return null;
  const id = url.searchParams.get("id") ?? "anon";
  const to = url.searchParams.get("to");
  const cur = jobs.get(id) ?? "queued";
  if (!to) return json({ status: cur });
  if (!NEXT[cur]?.includes(to)) return json({ status: cur });
  jobs.set(id, to);
  return json({ status: to });
}
