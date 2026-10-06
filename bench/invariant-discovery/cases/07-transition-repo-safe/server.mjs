// Bench-harness server for this case: the running app enforces the machine in
// src/orderMachine.js exactly — a cancelled order is terminal.
const NEXT = {
  pending: { pay: "paid", cancel: "cancelled" },
  paid: { fulfill: "fulfilled", cancel: "cancelled" },
  cancelled: {},
  fulfilled: {},
};
const orders = new Map();
const json = (body) => ({ status: 200, type: "application/json", body: JSON.stringify(body) });

export default function handle(url) {
  if (url.pathname !== "/api/order") return null;
  const id = url.searchParams.get("id") ?? "anon";
  const action = url.searchParams.get("action");
  const cur = orders.get(id) ?? "pending";
  if (!action) return json({ status: cur });
  const next = NEXT[cur]?.[action];
  if (!next) return json({ status: cur, error: "not allowed" });
  orders.set(id, next);
  return json({ status: next });
}
