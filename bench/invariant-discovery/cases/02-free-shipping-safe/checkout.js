// Offline cart preview. The server quote below is authoritative; this
// estimator is kept so the cart can show a number before the network answers.
const FREE_SHIPPING_THRESHOLD = 50;
const FLAT_RATE = 5.99;

function estimateShipping(cart) {
  let shipping = FLAT_RATE;
  if (cart.total >= FREE_SHIPPING_THRESHOLD) {
    shipping = 0;
  }
  return shipping;
}

// Bulk handling: no control on this page drives it.
function estimateHandling(order) {
  let handling = 2.5;
  if (order.quantity >= 10) {
    handling = 0;
  }
  return handling;
}

const input = document.getElementById("cart-total");
const out = document.getElementById("shipping");

async function refresh() {
  const res = await fetch("/api/quote?total=" + encodeURIComponent(input.value));
  const quote = await res.json();
  out.textContent = Number(quote.shipping).toFixed(2);
}
input.addEventListener("input", refresh);
input.addEventListener("change", refresh);
