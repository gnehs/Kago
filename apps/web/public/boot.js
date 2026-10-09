// Runs before anything is drawn, so that a dark desktop is never a light one first while the app is still on its way.
// It is a file of its own because the page's Content-Security-Policy runs no script written into the page, and it
// decides the same way applyPrefs() in src/lib/prefs.ts does, which takes over once it has loaded.
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem("kago.theme");
  } catch (error) {
    // Private browsing: the system decides.
  }
  if (theme !== "light" && theme !== "dark") theme = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  var bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.content = theme === "dark" ? "#3a3e44" : "#f7f8fa";
})();
