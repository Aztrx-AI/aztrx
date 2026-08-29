// Legacy fixture for `aztrx-cli modernize` — var + callbacks + promise chains.
var items = [];

function addItem(item, done) {
  var copy = items.slice();
  copy.push(item);
  setTimeout(function () {
    items = copy;
    done(null, items.length);
  }, 0);
}

addItem("first", function (err, count) {
  if (err) throw err;
  console.log("count:", count);
});
