const { app, BrowserWindow, ipcMain, shell, safeStorage, Tray, Menu, nativeImage, dialog } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const https = require("node:https");
const { autoUpdater } = require("electron-updater");

let mainWindow;
let tray;
let trayEnabled = false;
let isQuitting = false;
let authServer;
let arcadeWindow;
let updaterReady = false;
const pendingAuth = new Map();
const ircConnections = new Map();
const ircMessageTimes = new Map();
const authPort = 47831;
const authRedirectUri = `http://localhost:${authPort}/oauth/callback`;
const releaseRepository = "HWeebGamer/twitch-channel-control";
const hardwareAccelerationConfig = path.join(app.getPath("userData"), "hardware-acceleration.json");
try { if (JSON.parse(fs.readFileSync(hardwareAccelerationConfig, "utf8")).enabled === false) app.disableHardwareAcceleration(); } catch {}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const request = https.get(`https://api.github.com/repos/${releaseRepository}/releases/latest`, {
      headers: { "User-Agent": "Twitch-Channel-Control" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub returned HTTP ${response.statusCode}.`));
          return;
        }
        try {
          const release = JSON.parse(body);
          resolve({ version: String(release.tag_name || "").replace(/^v/i, ""), name: release.name || release.tag_name, url: release.html_url, publishedAt: release.published_at });
        } catch {
          reject(new Error("GitHub returned an invalid release response."));
        }
      });
    });
    request.setTimeout(8000, () => request.destroy(new Error("GitHub update check timed out.")));
    request.on("error", reject);
  });
}

function sendUpdateStatus(status, details = {}) {
  mainWindow?.webContents.send("update-status", { status, ...details });
}

function configureAutoUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => sendUpdateStatus("checking"));
  autoUpdater.on("update-available", (info) => sendUpdateStatus("available", { version: info.version }));
  autoUpdater.on("update-not-available", (info) => sendUpdateStatus("current", { version: info.version }));
  autoUpdater.on("download-progress", (progress) => sendUpdateStatus("downloading", { percent: Math.round(progress.percent), transferred: progress.transferred, total: progress.total }));
  autoUpdater.on("update-downloaded", (info) => sendUpdateStatus("downloaded", { version: info.version }));
  autoUpdater.on("error", (error) => sendUpdateStatus("error", { error: error.message }));
  updaterReady = true;
}

function backupRoot() {
  return path.join(app.getPath("userData"), "backups");
}

function accountCachePath() {
  return path.join(app.getPath("userData"), "account-cache.json");
}

function findBackupDirectories() {
  if (!fs.existsSync(backupRoot())) return [];
  return fs.readdirSync(backupRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(backupRoot(), entry.name, "cache.json")))
    .map((entry) => path.join(backupRoot(), entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function validateBackup(directory) {
  const cachePath = path.join(directory, "cache.json");
  const executablePath = ["Twitch Channel Control.exe", "Twitch Channel Control Portable.exe"]
    .map((name) => path.join(directory, name))
    .find((candidate) => fs.existsSync(candidate));
  if (!fs.existsSync(cachePath)) throw new Error("The selected backup does not contain cache.json.");
  if (!executablePath) throw new Error("The selected backup does not contain the executable.");
  return { cache: JSON.parse(fs.readFileSync(cachePath, "utf8")), executablePath };
}

function scheduleExecutableRestore(sourcePath) {
  if (!app.isPackaged) return false;
  const targetPath = process.execPath;
  const scriptPath = path.join(app.getPath("temp"), `twitch-channel-control-restore-${Date.now()}.ps1`);
  const script = `param([int]$ProcessId, [string]$Source, [string]$Target, [string]$Script)\nwhile ($true) { try { Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null; Start-Sleep -Milliseconds 250 } catch { break } }\nCopy-Item -LiteralPath $Source -Destination $Target -Force\nStart-Process -FilePath $Target\nRemove-Item -LiteralPath $Script -Force`;
  fs.writeFileSync(scriptPath, script, "utf8");
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(powershell, ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ProcessId", String(process.pid), "-Source", sourcePath, "-Target", targetPath, "-Script", scriptPath], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return true;
}

const chromeCandidates = [
  path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
];

function findChrome() {
  return chromeCandidates.find((candidate) => fs.existsSync(candidate));
}

function getChromeProfileRoot(accountId) {
  return path.join(app.getPath("userData"), "chrome-profiles", `account-${accountId}`);
}

function openChromeUrl(accountId, url, extraArgs = []) {
  const chrome = findChrome();
  if (!chrome) return { ok: false, error: "Google Chrome was not found in its standard Windows install locations." };
  const profileRoot = getChromeProfileRoot(accountId);
  fs.mkdirSync(profileRoot, { recursive: true });
  const child = spawn(chrome, [`--user-data-dir=${profileRoot}`, "--no-first-run", "--new-window", ...extraArgs, url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return { ok: true, profileRoot, url };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end(JSON.stringify(payload));
}

function authCallbackPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Twitch Authorization</title></head><body style="font-family:system-ui;background:#09090d;color:#f4f1fa;padding:32px"><h2>Completing Twitch authorization...</h2><p id="message">Please wait.</p><script>
    const message = document.getElementById("message");
    const values = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
    fetch("/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) })
      .then(async (response) => { const result = await response.json(); message.textContent = result.ok ? "Authorization complete. You can close this tab." : result.error; })
      .catch(() => { message.textContent = "The local control panel could not receive the authorization result."; });
  </script></body></html>`;
}

function storeAuthToken(record) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows secure storage is unavailable.");
  const tokenPath = path.join(app.getPath("userData"), "auth-tokens.json");
  let tokens = {};
  if (fs.existsSync(tokenPath)) {
    try { tokens = JSON.parse(fs.readFileSync(tokenPath, "utf8")); } catch { tokens = {}; }
  }
  tokens[String(record.accountId)] = safeStorage.encryptString(JSON.stringify(record)).toString("base64");
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { encoding: "utf8", mode: 0o600 });
}

function readAuthToken(accountId) {
  const tokenPath = path.join(app.getPath("userData"), "auth-tokens.json");
  if (!fs.existsSync(tokenPath)) return null;
  const tokens = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  const encrypted = tokens[String(accountId)];
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
  return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, "base64")));
}

function sendIrcStatus(accountId, status, channel, error = "") {
  mainWindow?.webContents.send("irc-status", { accountId, status, channel, error });
}

function parseIrcTags(rawTags) {
  const tags = {};
  String(rawTags || "").split(";").forEach((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) tags[part] = "";
    else tags[part.slice(0, separator)] = part.slice(separator + 1).replace(/\\s/g, " ").replace(/\\:/g, ";").replace(/\\s/g, " ");
  });
  return tags;
}

function parseIrcLine(line) {
  let remaining = String(line || "");
  let tags = {};
  if (remaining.startsWith("@")) {
    const end = remaining.indexOf(" ");
    if (end < 0) return null;
    tags = parseIrcTags(remaining.slice(1, end));
    remaining = remaining.slice(end + 1);
  }
  let prefix = "";
  if (remaining.startsWith(":")) {
    const end = remaining.indexOf(" ");
    if (end < 0) return null;
    prefix = remaining.slice(1, end);
    remaining = remaining.slice(end + 1);
  }
  const separator = remaining.indexOf(" :");
  const head = separator < 0 ? remaining : remaining.slice(0, separator);
  const text = separator < 0 ? "" : remaining.slice(separator + 2);
  const parts = head.split(" ").filter(Boolean);
  const command = parts.shift() || "";
  return {
    command,
    channel: parts.find((part) => part.startsWith("#")) || "",
    text,
    user: tags["display-name"] || prefix.split("!")[0] || "",
    tags,
  };
}

function sendIrcEvent(accountId, event) {
  if (!event || !event.command) return;
  mainWindow?.webContents.send("irc-event", {
    accountId,
    command: event.command,
    channel: event.channel,
    text: event.text,
    user: event.user,
    tags: event.tags,
    observedAt: new Date().toISOString(),
  });
}

async function validateTwitchToken(token) {
  const response = await fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: `OAuth ${token}` } });
  if (!response.ok) throw new Error("The stored Twitch authorization is invalid or expired.");
  return response.json();
}

async function isChannelLive(clientId, token, channel) {
  const response = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(channel)}`, {
    headers: { "Client-Id": clientId, Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) throw new Error("The Twitch authorization expired. Reauthorize this account.");
  if (!response.ok) throw new Error(`Twitch stream status check failed (${response.status}).`);
  const body = await response.json();
  return body.data.length > 0;
}

ipcMain.handle("get-channel-profile", async (_event, { accountId, channel }) => {
  const normalized = String(channel || "").replace(/^#/, "").trim().toLowerCase();
  const tokenRecord = readAuthToken(Number(accountId));
  if (!normalized || !tokenRecord) return { ok: false, error: "Authorize this account before loading channel images." };
  try {
    const response = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(normalized)}`, { headers: { "Client-Id": tokenRecord.clientId, Authorization: `Bearer ${tokenRecord.accessToken}` } });
    if (!response.ok) throw new Error(`Twitch profile lookup failed (${response.status}).`);
    const body = await response.json();
    const profile = body.data?.[0];
    if (!profile) return { ok: false, error: "Channel profile was not found." };
    return { ok: true, channel: profile.login, displayName: profile.display_name, profileImageUrl: profile.profile_image_url };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

function disconnectIrc(accountId, reason = "Part requested") {
  const connection = ircConnections.get(accountId);
  if (!connection) return { ok: true };
  clearInterval(connection.liveCheck);
  if (connection.socket.readyState === 1) connection.socket.send(`PART #${connection.channel}\r\n`);
  connection.socket.close();
  ircConnections.delete(accountId);
  sendIrcStatus(accountId, "parted", connection.channel, reason);
  return { ok: true };
}

async function connectIrc(accountId, channel) {
  const tokenRecord = readAuthToken(accountId);
  if (!tokenRecord) return { ok: false, error: "Authorize this account before joining IRC chat." };
  disconnectIrc(accountId, "Replacing previous channel connection");
  let identity;
  try {
    identity = await validateTwitchToken(tokenRecord.accessToken);
    if (!(await isChannelLive(tokenRecord.clientId, tokenRecord.accessToken, channel))) {
      return { ok: false, code: "OFFLINE", error: `#${channel} is currently offline.` };
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }

  return new Promise((resolve) => {
    const socket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    const connection = { socket, channel, liveCheck: null };
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (message) => {
      clearInterval(connection.liveCheck);
      ircConnections.delete(accountId);
      try { socket.close(); } catch {}
      sendIrcStatus(accountId, "error", channel, message);
      finish({ ok: false, error: message });
    };

    socket.addEventListener("open", () => {
      socket.send(`PASS oauth:${tokenRecord.accessToken}\r\n`);
      socket.send(`NICK ${identity.login}\r\n`);
      socket.send("CAP REQ :twitch.tv/membership twitch.tv/tags twitch.tv/commands\r\n");
      socket.send(`JOIN #${channel}\r\n`);
    });
    socket.addEventListener("message", (event) => {
      String(event.data).split("\r\n").filter(Boolean).forEach((line) => {
        try {
          const parsed = parseIrcLine(line);
          sendIrcEvent(accountId, parsed);
        } catch {
          sendIrcStatus(accountId, "warning", channel, "An IRC event could not be parsed and was ignored.");
        }
        if (line.startsWith("PING")) socket.send("PONG :tmi.twitch.tv\r\n");
        if (line.includes(" NOTICE ") && line.includes("Login authentication failed")) fail("Twitch rejected the stored authorization.");
        if (line.includes(` JOIN #${channel}`)) {
          ircConnections.set(accountId, connection);
          connection.liveCheck = setInterval(async () => {
            try {
              if (!(await isChannelLive(tokenRecord.clientId, tokenRecord.accessToken, channel))) disconnectIrc(accountId, "Channel went offline");
            } catch (error) {
              sendIrcStatus(accountId, "warning", channel, error.message);
            }
          }, 60000);
          sendIrcStatus(accountId, "joined", channel);
          finish({ ok: true });
        }
      });
    });
    socket.addEventListener("error", () => fail("The Twitch IRC connection failed."));
    socket.addEventListener("close", () => {
      if (!settled) fail("The Twitch IRC connection closed before joining the channel.");
      else if (ircConnections.has(accountId)) {
        clearInterval(connection.liveCheck);
        ircConnections.delete(accountId);
        sendIrcStatus(accountId, "disconnected", channel, "The Twitch IRC connection closed.");
      }
    });
    setTimeout(() => { if (!settled) fail("Twitch IRC did not confirm the channel join in time."); }, 15000);
  });
}

function ensureAuthServer() {
  if (authServer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    authServer = http.createServer((request, response) => {
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        response.end();
        return;
      }
      if (request.method === "GET" && request.url === "/oauth/callback") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(authCallbackPage());
        return;
      }
      if (request.method === "POST" && request.url === "/oauth/token") {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          try {
            const values = JSON.parse(body || "{}");
            const auth = pendingAuth.get(values.state);
            if (!auth) return sendJson(response, 400, { ok: false, error: "Authorization state was missing or expired." });
            pendingAuth.delete(values.state);
            if (values.error || !values.access_token) return sendJson(response, 400, { ok: false, error: values.error_description || "Twitch authorization was denied." });
            storeAuthToken({ accountId: auth.accountId, clientId: auth.clientId, accessToken: values.access_token, scope: values.scope || "", receivedAt: new Date().toISOString() });
            mainWindow?.webContents.send("twitch-auth-complete", { accountId: auth.accountId, scope: values.scope || "" });
            sendJson(response, 200, { ok: true });
          } catch (error) {
            sendJson(response, 500, { ok: false, error: error.message });
          }
        });
        return;
      }
      if (request.method === "POST" && request.url === "/points/update") {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          try {
            const values = JSON.parse(body || "{}");
            const slotId = Number(values.slotId);
            const points = values.points === null ? null : Number(values.points);
            if (!Number.isInteger(slotId) || slotId < 1 || slotId > 6 || (points !== null && (!Number.isSafeInteger(points) || points < 0))) {
              return sendJson(response, 400, { ok: false, error: "Invalid monitor update." });
            }
            mainWindow?.webContents.send("points-update", {
              accountId: slotId,
              channel: String(values.channel || ""),
              points,
              observedAt: String(values.observedAt || new Date().toISOString()),
              profileId: String(values.profileId || ""),
            });
            sendJson(response, 200, { ok: true });
          } catch (error) {
            sendJson(response, 400, { ok: false, error: error.message });
          }
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    authServer.once("error", (error) => { authServer = null; reject(error); });
    authServer.listen(authPort, "localhost", resolve);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 850,
    minHeight: 640,
    title: "Twitch Channel Control",
    show: true,
    backgroundColor: "#09090d",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.loadFile("index.html");
  mainWindow.on("close", (event) => {
    if (trayEnabled && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, "assets", "alt-icon.ico");
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip("Twitch Channel Control");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Twitch Channel Control", click: () => mainWindow?.show() },
    { type: "separator" },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on("click", () => mainWindow?.show());
}

function destroyTray() {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

ipcMain.handle("open-chrome-profile", async (_event, { accountId, channel, monitor }) => {
  const url = channel ? `https://www.twitch.tv/${encodeURIComponent(channel)}` : "https://www.twitch.tv/";
  if (!monitor || !channel) return openChromeUrl(accountId, url);
  try {
    await ensureAuthServer();
    const extensionPath = app.isPackaged
      ? path.join(process.resourcesPath, "browser-extension")
      : path.join(__dirname, "browser-extension");
    return openChromeUrl(accountId, `${url}?alt_monitor_slot=${Number(accountId)}`, [`--load-extension=${extensionPath}`]);
  } catch (error) {
    return { ok: false, error: `Could not start the channel monitor: ${error.message}` };
  }
});

ipcMain.handle("open-auth-in-profile", (_event, { accountId, url }) => openChromeUrl(accountId, url));
ipcMain.handle("open-betterttv-in-profile", (_event, { accountId }) => openChromeUrl(accountId, "https://chromewebstore.google.com/detail/betterttv/ajopnjidmegmdimjlfnijceegpefgped"));

ipcMain.handle("install-points-monitor", async (_event, { accountId, channel }) => {
  if (!channel) return { ok: false, error: "Join a channel before setting up the points monitor." };
  try {
    await ensureAuthServer();
    const extensionPath = app.isPackaged
      ? path.join(process.resourcesPath, "browser-extension")
      : path.join(__dirname, "browser-extension");
    const url = `https://www.twitch.tv/${encodeURIComponent(channel)}?alt_monitor_slot=${Number(accountId)}`;
    const result = openChromeUrl(accountId, url, [`--load-extension=${extensionPath}`]);
    shell.openPath(extensionPath);
    return { ...result, extensionPath, installInstructions: "In chrome://extensions, enable Developer mode and choose Load unpacked, then select the provided browser-extension folder." };
  } catch (error) {
    return { ok: false, error: `Could not start the points monitor: ${error.message}` };
  }
});

ipcMain.handle("set-tray-mode", (_event, enabled) => {
  trayEnabled = Boolean(enabled);
  if (trayEnabled) createTray();
  else destroyTray();
  return { ok: true, enabled: trayEnabled };
});

ipcMain.handle("create-backup", (_event, cache) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const directory = path.join(backupRoot(), `backup-${timestamp}`);
    fs.mkdirSync(directory, { recursive: true });
    const snapshot = cache && typeof cache === "object" ? cache : {};
    const accountCache = {
      accounts: Array.isArray(snapshot.accounts) ? snapshot.accounts : [],
      savedAt: snapshot.savedAt || new Date().toISOString(),
    };
    fs.copyFileSync(process.execPath, path.join(directory, path.basename(process.execPath)));
    fs.writeFileSync(path.join(directory, "cache.json"), JSON.stringify(snapshot, null, 2), "utf8");
    fs.writeFileSync(path.join(directory, "account-cache.json"), JSON.stringify(accountCache, null, 2), "utf8");
    return { ok: true, path: directory, accountCount: accountCache.accounts.length };
  } catch (error) {
    return { ok: false, error: `Backup failed: ${error.message}` };
  }
});

ipcMain.handle("restore-backup", async () => {
  try {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: "question",
      title: "Restore backup",
      message: "Choose how to restore Channel Control.",
      detail: "Latest backup uses the most recent backup created by this app. Choose backup folder lets you select a backup folder manually.",
      buttons: ["Latest backup", "Choose backup folder", "Cancel"],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice.response === 2) return { ok: false, cancelled: true };
    let directory = findBackupDirectories()[0];
    if (choice.response === 1) {
      const selected = await dialog.showOpenDialog(mainWindow, { title: "Select Channel Control backup folder", properties: ["openDirectory"] });
      if (selected.canceled || !selected.filePaths[0]) return { ok: false, cancelled: true };
      directory = selected.filePaths[0];
    }
    if (!directory) throw new Error("No app-created backup was found.");
    const backup = validateBackup(directory);
    const restartScheduled = scheduleExecutableRestore(backup.executablePath);
    return { ok: true, path: directory, cache: backup.cache, restartScheduled };
  } catch (error) {
    return { ok: false, error: `Restore failed: ${error.message}` };
  }
});

ipcMain.handle("quit-for-restore", () => {
  isQuitting = true;
  app.quit();
  return { ok: true };
});

ipcMain.handle("load-account-cache", () => {
  try {
    const filePath = accountCachePath();
    if (!fs.existsSync(filePath)) return { ok: true, accounts: [] };
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { ok: true, accounts: Array.isArray(saved.accounts) ? saved.accounts : [] };
  } catch (error) {
    return { ok: false, accounts: [], error: error.message };
  }
});

ipcMain.handle("save-account-cache", (_event, accounts) => {
  try {
    const filePath = accountCachePath();
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ accounts, savedAt: new Date().toISOString() }, null, 2), "utf8");
    fs.renameSync(temporaryPath, filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("recover-authorized-accounts", async () => {
  const recovered = [];
  for (let accountId = 1; accountId <= 6; accountId += 1) {
    try {
      const tokenRecord = readAuthToken(accountId);
      if (!tokenRecord) continue;
      const identity = await validateTwitchToken(tokenRecord.accessToken);
      recovered.push({ accountId, name: identity.login, clientId: tokenRecord.clientId });
    } catch {
      // An expired or invalid token cannot safely identify the account.
    }
  }
  return { ok: true, accounts: recovered };
});

ipcMain.handle("open-external", (_event, url) => {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
    return { ok: false, error: "Only secure HTTPS links can be opened." };
  }
  shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("select-arcade-folder", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) || arcadeWindow || mainWindow;
  const result = await dialog.showOpenDialog(owner, { title: "Select the AnonTW game folder", properties: ["openDirectory"] });
  return result.canceled || !result.filePaths[0] ? { ok: false, cancelled: true } : { ok: true, folder: result.filePaths[0] };
});

ipcMain.handle("open-arcade-window", () => {
  if (arcadeWindow && !arcadeWindow.isDestroyed()) { arcadeWindow.show(); arcadeWindow.focus(); return { ok: true, reused: true }; }
  arcadeWindow = new BrowserWindow({ width: 1000, height: 760, minWidth: 720, minHeight: 520, title: "Channel Control Arcade", backgroundColor: "#09090d", webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.js") } });
  arcadeWindow.loadFile("arcade.html");
  arcadeWindow.on("closed", () => { arcadeWindow = null; });
  return { ok: true };
});

ipcMain.handle("launch-arcade-game", (_event, folder) => {
  const root = typeof folder === "string" ? folder : "";
  const candidates = ["Emuera1824+v21+EMv18+EEv47 NAudio.exe", "Emuera1824+v21+EMv18+EEv47 NAudio.exe"];
  const executable = candidates.map((name) => path.join(root, name)).find((candidate) => fs.existsSync(candidate));
  if (!executable) return { ok: false, error: "The Emuera game executable was not found in that folder." };
  try {
    const game = spawn(executable, [], { cwd: root, detached: true, stdio: "ignore", windowsHide: false });
    game.unref();
    return { ok: true, mode: "managed", message: "The game opened in its own managed window." };
  } catch (error) {
    return { ok: false, error: `The game could not be launched: ${error.message}` };
  }
});

ipcMain.handle("check-for-updates", async () => {
  if (updaterReady) {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, currentVersion: app.getVersion(), version: result?.updateInfo?.version || app.getVersion(), available: Boolean(result?.isUpdateAvailable) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  try {
    const release = await fetchLatestRelease();
    const currentVersion = app.getVersion();
    return { ok: true, currentVersion, ...release, available: release.version !== currentVersion };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("download-update", async () => {
  if (!updaterReady) return { ok: false, error: "In-app updates are available only in the installed version." };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("install-update", () => {
  if (!updaterReady) return { ok: false, error: "In-app updates are available only in the installed version." };
  isQuitting = true;
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});

ipcMain.handle("start-twitch-auth", async (_event, { accountId, clientId, redirectUri }) => {
  if (!clientId || redirectUri !== authRedirectUri) {
    return { ok: false, error: `Use the registered redirect URL: ${authRedirectUri}` };
  }
  try {
    await ensureAuthServer();
    const state = crypto.randomBytes(24).toString("hex");
    pendingAuth.set(state, { accountId, clientId });
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "token", scope: "chat:read chat:edit", state });
    return { ok: true, authUrl: `https://id.twitch.tv/oauth2/authorize?${params.toString()}` };
  } catch (error) {
    return { ok: false, error: `Could not start the local authorization listener: ${error.message}` };
  }
});

ipcMain.handle("irc-join", (_event, { accountId, channel }) => connectIrc(accountId, channel));
ipcMain.handle("set-hardware-acceleration", async (_event, enabled) => {
  try { fs.mkdirSync(path.dirname(hardwareAccelerationConfig), { recursive: true }); fs.writeFileSync(hardwareAccelerationConfig, JSON.stringify({ enabled: Boolean(enabled) }), "utf8"); return { ok: true }; } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle("irc-part", (_event, { accountId }) => disconnectIrc(accountId));
ipcMain.handle("irc-send-message", (_event, { accountId, message }) => {
  const connection = ircConnections.get(Number(accountId));
  const text = String(message || "").trim();
  if (!connection) return { ok: false, error: "This account is not currently joined to IRC." };
  if (!text) return { ok: false, error: "Enter a message before sending." };
  if (text.length > 450) return { ok: false, error: "IRC messages must be 450 characters or fewer." };
  const now = Date.now();
  const previous = ircMessageTimes.get(Number(accountId)) || 0;
  if (now - previous < 2500) return { ok: false, error: "Please wait before sending another message from this account." };
  if (connection.socket.readyState !== 1) return { ok: false, error: "The IRC connection is not ready." };
  try {
    connection.socket.send(`PRIVMSG #${connection.channel} :${text}\r\n`);
  } catch (error) {
    return { ok: false, error: `The IRC message could not be sent: ${error.message}` };
  }
  ircMessageTimes.set(Number(accountId), now);
  return { ok: true };
});

app.whenReady().then(() => {
  configureAutoUpdater();
  createWindow();
  if (updaterReady) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3500);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (trayEnabled) return;
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  isQuitting = true;
  destroyTray();
  authServer?.close();
  ircConnections.forEach((_connection, accountId) => disconnectIrc(accountId, "Application closed"));
});
