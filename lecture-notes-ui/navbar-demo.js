(function () {
  "use strict";
  var out = document.getElementById("nb-demo-out");
  AQ.navbar.mount(document.getElementById("nb-demo-mount"), {
    items: AQ.navbar.DEFAULT_ITEMS,
    active: "dashboard",
    onSelect: function (id) { out.textContent = "Active: " + id; }
  });
})();
