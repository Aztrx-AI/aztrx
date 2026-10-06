// Bench-harness server for this case: the running app. The latest change moved
// the free-shipping threshold to 50 in src/shipping.js, but this server still
// compares with `>`, so a cart of exactly 50 is charged.
export default function handle(url) {
  if (url.pathname !== "/api/quote") return null;
  const total = Number(url.searchParams.get("total"));
  const shipping = total > 50 ? 0 : 5.99;
  return { status: 200, type: "application/json", body: JSON.stringify({ shipping }) };
}
