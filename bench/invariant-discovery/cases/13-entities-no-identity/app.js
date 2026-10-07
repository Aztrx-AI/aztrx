// A list page whose rows say nothing that tells one job from another: every row
// reads "Background job", and the page addresses a job by its position in the
// list the server returned.
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
        "<tr><td>Background job</td><td><span>" + j.status + "</span></td><td>" +
        '<select aria-label="Move job">' +
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
  load("&at=" + Array.from(body.children).indexOf(row) + "&to=" + encodeURIComponent(e.target.value));
});
load();
