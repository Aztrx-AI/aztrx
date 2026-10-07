// Thin client: choosing a status asks the server, and the page shows its answer.
let jobId = localStorage.getItem("job-id");
if (!jobId) {
  jobId = "j" + Math.random().toString(36).slice(2, 10);
  localStorage.setItem("job-id", jobId);
}
const statusEl = document.getElementById("job-status");
const select = document.getElementById("move");

async function call(to) {
  const res = await fetch("/api/job?id=" + encodeURIComponent(jobId) + (to ? "&to=" + encodeURIComponent(to) : ""));
  const body = await res.json();
  statusEl.textContent = body.status;
  select.value = body.status;
}
select.addEventListener("change", () => call(select.value));
call();
