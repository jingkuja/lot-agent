import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "./i18n/index.js";
import App from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LanguageProvider><App /></LanguageProvider>
  </StrictMode>
);
