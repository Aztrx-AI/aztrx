// The page only asks the server for a quote; the pricing rules live server-side.
const input = document.getElementById("cart-total");
const out = document.getElementById("shipping");

async function refresh() {
  const res = await fetch("/api/quote?total=" + encodeURIComponent(input.value));
  const quote = await res.json();
  out.textContent = Number(quote.shipping).toFixed(2);
}
input.addEventListener("input", refresh);
input.addEventListener("change", refresh);
