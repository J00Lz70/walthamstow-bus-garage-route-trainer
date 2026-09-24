// Walthamstow Bus Garage Route Trainer for Windows.
// Opens the hosted web app, so new versions and TfL updates arrive without reinstalling.
// If the web app can't be reached and nothing is cached yet, it opens the copy bundled with the installer.
const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const fs = require("fs");

let cfg = { url: "" };
try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); } catch (e) {}
const OFFLINE = path.join(__dirname, "offline", "index.html");

// Keep the settings folder from before the rename, so drill progress and checklists carry over
app.setPath("userData", path.join(app.getPath("appData"), "Walthamstow Route Trainer"));

if (!app.requestSingleInstanceLock()) app.quit();

let win;
function openExternal(url) { if (/^https?:\/\//i.test(url)) shell.openExternal(url); }

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 860, minWidth: 380, minHeight: 500,
    backgroundColor: "#EEF1F3", autoHideMenuBar: true, title: "Walthamstow Bus Garage Route Trainer",
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => {
    const inApp = (cfg.url && url.startsWith(cfg.url)) || url.startsWith("file:");
    if (!inApp) { e.preventDefault(); openExternal(url); }
  });
  let fellBack = false;
  win.webContents.on("did-fail-load", (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && !fellBack && code !== -3) { fellBack = true; win.loadFile(OFFLINE); }
  });
  if (cfg.url) win.loadURL(cfg.url); else win.loadFile(OFFLINE);
}

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
