// A list page: every job is a row with its own status and its own select.
// The server owns the data and keeps the list sorted by status, so a row moves
// when its status changes.
let sid = localStorage.getItem("jobs-sid");
if (!sid) {
  sid = "s" + Math.random().toString(36).slice(2, 10);
  localStorage.setItem("jobs-sid", sid);
}
const STATUSES = ["queued", "running", "done", "failed", "cancelled"];
const body = document.getElementById("jobs");

function render(list) {
  body.innerHTML = list
    .map(
      (j) =>
        '<tr data-job="' + j.id + '"><td>' + j.id + "</td><td><span>" + j.status + "</span></td><td>" +
        '<select aria-label="Move ' + j.id + '">' +
        STATUSES.map((s) => "<option" + (s === j.status ? " selected" : "") + ">" + s + "</option>").join("") +
        "</select></td></tr>"
    )
    .join("");
}

async function load(query) {
  const res = await fetch("/api/jobs?sid=" + encodeURIComponent(sid) + (query || ""));
  render(await res.json());
}

body.addEventListener("change", (e) => {
  const row = e.target.closest("tr");
  load("&id=" + encodeURIComponent(row.getAttribute("data-job")) + "&to=" + encodeURIComponent(e.target.value));
});
load();
