// Bench-harness server for this case. The seeded bug: the server's free-shipping
// test is `>` where the code the client was served says `>=`, so a cart
// of exactly the threshold is charged.
export default function handle(url) {
  if (url.pathname !== "/api/quote") return null;
  const total = Number(url.searchParams.get("total"));
  const shipping = total > 50 ? 0 : 5.99;
  return { status: 200, type: "application/json", body: JSON.stringify({ shipping }) };
}
