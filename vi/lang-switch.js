// Adds a language toggle (EN ⇄ VI) to the mdBook top menu bar.
// Both editions share identical chapter file names, so switching is just
// swapping the /en/ ↔ /vi/ path segment while staying on the same page.
(function () {
  "use strict";
  var path = window.location.pathname;
  var isVi = path.indexOf("/vi/") !== -1;
  var target = isVi ? path.replace("/vi/", "/en/") : path.replace("/en/", "/vi/");
  var label = isVi ? "EN" : "VI";
  var title = isVi ? "Read in English" : "Đọc bằng tiếng Việt";

  function addButton() {
    var bar = document.querySelector(".menu-bar .right-buttons") ||
              document.querySelector(".right-buttons");
    if (!bar) return;
    if (document.getElementById("lang-switch")) return;
    var a = document.createElement("a");
    a.id = "lang-switch";
    a.href = target;
    a.title = title;
    a.className = "icon-button";
    a.setAttribute("aria-label", title);
    a.style.fontWeight = "700";
    a.style.width = "auto";
    a.style.padding = "0 8px";
    a.textContent = label;
    bar.appendChild(a);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", addButton);
  } else {
    addButton();
  }
})();
