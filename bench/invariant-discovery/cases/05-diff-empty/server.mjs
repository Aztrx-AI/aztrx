// Bench-harness server for this case: the running app, which has the same
// off-by-one as case 03. Nothing is edited here, so a run that reads the diff
// must find no changed code, and must not invent a rule to check.
export default function handle(url) {
  if (url.pathname !== "/api/quote") return null;
  const total = Number(url.searchParams.get("total"));
  const shipping = total > 50 ? 0 : 5.99;
  return { status: 200, type: "application/json", body: JSON.stringify({ shipping }) };
}
