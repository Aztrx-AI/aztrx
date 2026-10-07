// Bench-harness server for this case: the running app. Jobs are kept per id.
// The seeded bug: the latest change lets a failed job be retried (-> queued),
// but this server was edited sloppily and also lets a failed job jump straight
// to done. Every other move is enforced.
const NEXT = {
  queued: ["running", "cancelled"],
  running: ["done", "failed"],
  done: [],
  failed: ["queued", "done"], // stale/wrong: "done" is not in the declared list
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
