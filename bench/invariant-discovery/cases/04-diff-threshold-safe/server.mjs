// Bench-harness server for this case: the running app honours the threshold
// the latest change put in src/shipping.js (`>=`), so the rule holds.
export default function handle(url) {
  if (url.pathname !== "/api/quote") return null;
  const total = Number(url.searchParams.get("total"));
  const shipping = total >= 50 ? 0 : 5.99;
  return { status: 200, type: "application/json", body: JSON.stringify({ shipping }) };
}
