import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./tokens.css";
import "./styles.css";
import "./ui/ui.css";
import "./shell/shell.css";
import "./appearance.css";
import "./code.css";
import "./skills.css";
import "./models.css";
import { applyTo, readAppearance } from "./appearance";
import { startThemeSync } from "./themeSync";
import { routeLinks } from "./desktop";

applyTo(document.documentElement, readAppearance());
startThemeSync(readAppearance());
routeLinks(); // the Rooks app: new-window links go to the browser, files are saved (WebKit opens no new window)

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
