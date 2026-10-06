// Thin client: every action is a request, and the page shows what the server answers.
let orderId = localStorage.getItem("order-id");
if (!orderId) {
  orderId = "o" + Math.random().toString(36).slice(2, 10);
  localStorage.setItem("order-id", orderId);
}
const statusEl = document.getElementById("order-status");
const noticeEl = document.getElementById("notice");

async function call(action) {
  const q = "/api/order?id=" + encodeURIComponent(orderId) + (action ? "&action=" + action : "");
  const res = await fetch(q);
  const body = await res.json();
  statusEl.textContent = body.status;
  noticeEl.textContent = body.error ? "That action is not available." : "";
}

for (const action of ["pay", "cancel", "fulfill"]) {
  document.getElementById(action).addEventListener("click", () => call(action));
}
call();
