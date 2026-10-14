import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline shell for the installed PWA. Production only — the dev server must
// never be captured by a cache. Registration failure is non-fatal: the game
// still runs, just without offline play.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Service workers need a secure context (HTTPS or localhost); ignore.
    });
  });
}
