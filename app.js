const accounts = Array.from({ length: 6 }, (_, index) => ({
  id: index + 1,
  name: "",
  profile: `Profile ${index + 1}`,
  channel: "",
  clientId: "",
  authorized: false,
  status: "disconnected",
  joined: false,
  points: null,
  pointsUpdatedAt: "",
  monitorLinked: false,
  lastDiagnosticPoints: undefined,
  channelIcon: "",
}));

const accountCacheKey = "twitch-channel-control.accounts.v1";
const settingsKey = "twitch-channel-control.settings.v1";
const channelProfileCacheKey = "twitch-channel-control.channel-profiles.v1";
let channelProfiles = {};
const appSettings = { trayMode: false, ircSlowMode: true, hardwareAcceleration: true };

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey) || "{}");
    if (typeof saved.trayMode === "boolean") appSettings.trayMode = saved.trayMode;
    if (typeof saved.ircSlowMode === "boolean") appSettings.ircSlowMode = saved.ircSlowMode;
    if (typeof saved.hardwareAcceleration === "boolean") appSettings.hardwareAcceleration = saved.hardwareAcceleration;
  } catch (error) {
    addDiagnostic("error", `Saved settings could not be loaded: ${error.message}`);
  }
}

function loadChannelProfiles() {
  try { const saved = JSON.parse(localStorage.getItem(channelProfileCacheKey) || "{}"); if (saved && typeof saved === "object") channelProfiles = saved; } catch (error) { addDiagnostic("warning", `Channel image cache could not be loaded: ${error.message}`); }
}

function saveChannelProfiles() { localStorage.setItem(channelProfileCacheKey, JSON.stringify(channelProfiles)); }

async function refreshChannelProfile(account) {
  if (!account.channel || !account.authorized || !window.desktopBridge?.getChannelProfile) return;
  const channel = account.channel.toLowerCase();
  const cached = channelProfiles[channel];
  if (cached?.profileImageUrl) { account.channelIcon = cached.profileImageUrl; renderProfileStats(); }
  const result = await window.desktopBridge.getChannelProfile(account.id, channel);
  if (!result.ok) return;
  channelProfiles[channel] = { displayName: result.displayName, profileImageUrl: result.profileImageUrl, cachedAt: new Date().toISOString() };
  account.channelIcon = result.profileImageUrl;
  saveChannelProfiles();
  renderProfileStats();
}

function refreshSelectedChannelProfiles() { accounts.filter((account) => account.status === "connected" && account.channel).forEach(refreshChannelProfile); }

function saveSettings() {
  localStorage.setItem(settingsKey, JSON.stringify(appSettings));
}

function loadAccounts() {
  try {
    const saved = JSON.parse(localStorage.getItem(accountCacheKey) || "[]");
    if (!Array.isArray(saved)) return;
    saved.forEach((cached) => {
      const account = accounts.find((item) => item.id === cached.id);
      if (!account || !cached.name) return;
      account.name = String(cached.name);
      account.profile = String(cached.profile || `Profile ${account.id}`);
      account.channel = String(cached.channel || "");
      account.clientId = String(cached.clientId || "");
      account.authorized = Boolean(cached.authorized);
      account.monitorLinked = Boolean(cached.monitorLinked);
      account.status = "connected";
      account.joined = false;
    });
  } catch (error) {
    addDiagnostic("error", `Saved account cache could not be loaded: ${error.message}`);
  }
}

function saveAccounts() {
  try {
    const cache = accounts
      .filter((account) => account.name)
      .map(({ id, name, profile, channel, clientId, authorized, monitorLinked }) => ({ id, name, profile, channel, clientId, authorized, monitorLinked }));
    localStorage.setItem(accountCacheKey, JSON.stringify(cache));
    window.desktopBridge?.saveAccountCache(cache);
  } catch (error) {
    addDiagnostic("error", `Account cache could not be saved: ${error.message}`);
  }
}

async function hydrateAccountsFromDisk() {
  if (!window.desktopBridge?.loadAccountCache) return;
  const result = await window.desktopBridge.loadAccountCache();
  if (!result.ok) {
    addDiagnostic("error", `App account cache could not be loaded: ${result.error}`);
    return;
  }
  const diskAccounts = result.accounts.filter((cached) => cached && cached.name);
  if (!diskAccounts.length) {
    if (window.desktopBridge.recoverAuthorizedAccounts) {
      const recovery = await window.desktopBridge.recoverAuthorizedAccounts();
      recovery.accounts?.forEach((cached) => {
        const account = accounts.find((item) => item.id === Number(cached.accountId));
        if (!account || account.name || !cached.name) return;
        account.name = String(cached.name);
        account.clientId = String(cached.clientId || "");
        account.authorized = true;
        account.status = "connected";
      });
    }
    saveAccounts();
    renderAccounts();
    refreshSelectedChannelProfiles();
    const recoveredCount = accounts.filter((account) => account.status === "connected").length;
    if (recoveredCount) {
      setLastAction(`${recoveredCount} authorized account${recoveredCount === 1 ? "" : "s"} recovered`);
      addDiagnostic("success", "Missing account slots were recovered from stored Twitch authorization.");
    }
    return;
  }
  accounts.forEach((account) => {
    account.name = "";
    account.profile = `Profile ${account.id}`;
    account.channel = "";
    account.clientId = "";
    account.authorized = false;
    account.status = "disconnected";
    account.joined = false;
    account.monitorLinked = false;
    account.points = null;
    account.pointsUpdatedAt = "";
  });
  diskAccounts.forEach((cached) => {
    const account = accounts.find((item) => item.id === Number(cached.id));
    if (!account) return;
    account.name = String(cached.name);
    account.profile = String(cached.profile || `Profile ${account.id}`);
    account.channel = String(cached.channel || "");
    account.clientId = String(cached.clientId || "");
    account.authorized = Boolean(cached.authorized);
    account.monitorLinked = Boolean(cached.monitorLinked);
    account.status = "connected";
    account.joined = false;
  });
  saveAccounts();
  renderAccounts();
  const restoredCount = accounts.filter((account) => account.status === "connected").length;
  setLastAction(`${restoredCount} cached account${restoredCount === 1 ? "" : "s"} restored`);
  addDiagnostic("info", "The app-owned account cache restored slots missing from browser storage.");
  refreshSelectedChannelProfiles();
}

function cacheSnapshot() {
  return {
    accounts: accounts.filter((account) => account.name).map(({ id, name, profile, channel, clientId, authorized, monitorLinked }) => ({ id, name, profile, channel, clientId, authorized, monitorLinked })),
    settings: { ...appSettings },
    savedAt: new Date().toISOString(),
  };
}

const accountList = document.querySelector("#accountList");
const diagnosticList = document.querySelector("#diagnosticList");
const connectDialog = document.querySelector("#connectDialog");
const connectForm = document.querySelector("#connectForm");
const accountNameInput = document.querySelector("#accountName");
const browserProfileInput = document.querySelector("#browserProfile");
const dialogTitle = document.querySelector("#dialogTitle");
const channelDialog = document.querySelector("#channelDialog");
const channelForm = document.querySelector("#channelForm");
const channelNameInput = document.querySelector("#channelName");
const channelDialogTitle = document.querySelector("#channelDialogTitle");
const authDialog = document.querySelector("#authDialog");
const authForm = document.querySelector("#authForm");
const authDialogTitle = document.querySelector("#authDialogTitle");
const clientIdInput = document.querySelector("#clientId");
const redirectUriInput = document.querySelector("#redirectUri");
const profileStatsGrid = document.querySelector("#profileStatsGrid");
const trayToggle = document.querySelector("#trayToggle");
const hardwareAccelerationToggle = document.querySelector("#hardwareAccelerationToggle");
const checkForUpdatesButton = document.querySelector("#checkForUpdates");
const updateStatus = document.querySelector("#updateStatus");
const downloadUpdateButton = document.querySelector("#downloadUpdate");
const installUpdateButton = document.querySelector("#installUpdate");
const openArcadeWindowButton = document.querySelector("#openArcadeWindowButton");
const guideDialog = document.querySelector("#guideDialog");
const ircAccountSelect = document.querySelector("#ircAccountSelect");
const ircChannelSelect = document.querySelector("#ircChannelSelect");
const ircFilterSelect = document.querySelector("#ircFilterSelect");
const ircSlowModeToggle = document.querySelector("#ircSlowModeToggle");
const ircMessageForm = document.querySelector("#ircMessageForm");
const ircMessageInput = document.querySelector("#ircMessageInput");
const ircStatusGrid = document.querySelector("#ircStatusGrid");
const ircLog = document.querySelector("#ircLog");
let selectedAccountId = null;
let selectedJoinAccountId = null;
let selectedAuthAccountId = null;
const ircDashboardState = {
  events: [],
  statuses: new Map(),
  lastChatEventAt: 0,
  slowModeUntil: 0,
  suppressedChatMessages: 0,
  slowModeTimer: null,
  slowModeNoticeShown: false,
  slowMode: true,
  seenChatMessages: new Set(),
};

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;",
  }[character]));
}

function accountState(account) {
  if (account.status === "disconnected") return { label: "Disconnected", className: "" };
  if (account.joined) return { label: "In channel", className: "active" };
  return { label: "Connected", className: "connected" };
}

function renderAccounts() {
  accountList.innerHTML = accounts.map((account) => {
    const state = accountState(account);
    const connected = account.status === "connected";
    const safeName = account.name ? escapeHtml(account.name) : "Empty slot";
    const safeChannel = account.channel ? `#${escapeHtml(account.channel)}` : "No channel selected";
    return `
      <article class="account-row">
        <div class="account-top">
          <span class="account-number">${account.id}</span>
          <div>
            <p class="account-name">${safeName}</p>
            <p class="account-meta">${connected ? `<span>${safeChannel} · ${escapeHtml(account.profile)}</span>${account.channel ? `<button class="inline-action" data-action="open-channel" data-id="${account.id}" type="button">Open</button>` : ""}` : "Ready for connection"}</p>
          </div>
          <div class="account-state ${state.className}">
            <span class="state-dot"></span>
            <span>${state.label}</span>
          </div>
        </div>
        <div class="account-actions">
          ${connected ? `<button class="button secondary" data-action="disconnect" data-id="${account.id}">Disconnect</button>` : `<button class="button primary" data-action="connect" data-id="${account.id}">Connect</button>`}
          <button class="button secondary" data-action="authorize" data-id="${account.id}">${account.authorized ? "Reauthorize" : "Authorize"}</button>
          <button class="button secondary" data-action="betterttv" data-id="${account.id}">BetterTTV</button>
          <button class="button secondary" data-action="join" data-id="${account.id}" ${connected ? "" : "disabled"}>Join</button>
          <button class="button danger" data-action="part" data-id="${account.id}" ${account.joined ? "" : "disabled"}>Part</button>
        </div>
      </article>`;
  }).join("");
  updateSummary();
  renderProfileStats();
  renderIrcDashboard();
}

function updateSummary() {
  document.querySelector("#connectedCount").textContent = `${accounts.filter((account) => account.status === "connected").length} / 6`;
  document.querySelector("#activeCount").textContent = accounts.filter((account) => account.joined).length;
}

function setSystemState(state, text) {
  const systemState = document.querySelector("#systemState");
  systemState.dataset.state = state;
  document.querySelector("#systemStateText").textContent = text;
}

function addDiagnostic(type, message) {
  const entry = document.createElement("article");
  entry.className = `diagnostic-entry ${type}`;
  entry.innerHTML = `<div class="diagnostic-head"><span class="diagnostic-type">${type}</span><span class="diagnostic-time">${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div><p class="diagnostic-message">${escapeHtml(message)}</p>`;
  const empty = diagnosticList.querySelector(".empty-state");
  if (empty) empty.remove();
  diagnosticList.prepend(entry);
}

function clearDiagnostics() {
  diagnosticList.innerHTML = `<div class="empty-state">Diagnostics will clear automatically after one hour.</div>`;
}

function addIrcEvent(event) {
  if (!event || !event.command) return;
  const now = Date.now();
  if (event.command === "PRIVMSG") {
    const channel = String(event.channel || "").toLowerCase();
    const messageId = event.tags?.id || `${event.tags?.["tmi-sent-ts"] || Math.floor(now / 1000)}|${event.user || ""}|${event.text || ""}`;
    const duplicateKey = `${channel}|${messageId}`;
    if (ircDashboardState.seenChatMessages.has(duplicateKey)) return;
    ircDashboardState.seenChatMessages.add(duplicateKey);
    if (ircDashboardState.seenChatMessages.size > 1200) {
      ircDashboardState.seenChatMessages.delete(ircDashboardState.seenChatMessages.values().next().value);
    }
    if (!ircDashboardState.slowMode) {
      ircDashboardState.events.unshift(event);
      if (ircDashboardState.events.length > 250) ircDashboardState.events.length = 250;
      renderIrcDashboard();
      return;
    }
    const burstDetected = ircDashboardState.lastChatEventAt && now - ircDashboardState.lastChatEventAt < 1800;
    if (burstDetected || now < ircDashboardState.slowModeUntil) {
      ircDashboardState.suppressedChatMessages += 1;
      ircDashboardState.slowModeUntil = now + 7000;
      if (!ircDashboardState.slowModeNoticeShown) {
        ircDashboardState.slowModeNoticeShown = true;
        ircDashboardState.events.unshift({
          accountId: event.accountId,
          command: "CHAT SLOW MODE",
          text: "Chat is moving too fast; additional messages are being suppressed.",
          channel: event.channel,
          observedAt: new Date().toISOString(),
        });
      }
      if (ircDashboardState.slowModeTimer) window.clearTimeout(ircDashboardState.slowModeTimer);
      ircDashboardState.slowModeTimer = window.setTimeout(() => {
        ircDashboardState.slowModeTimer = null;
        ircDashboardState.suppressedChatMessages = 0;
        ircDashboardState.slowModeUntil = 0;
        ircDashboardState.slowModeNoticeShown = false;
        renderIrcDashboard();
      }, 7000);
      renderIrcDashboard();
      return;
    }
    ircDashboardState.lastChatEventAt = now;
  }
  ircDashboardState.events.unshift(event);
  if (ircDashboardState.events.length > 250) ircDashboardState.events.length = 250;
  renderIrcDashboard();
}

function renderIrcDashboard() {
  if (!ircAccountSelect || !ircChannelSelect || !ircFilterSelect || !ircStatusGrid || !ircLog) return;
  const slowModeState = document.querySelector("#ircSlowModeState");
  if (slowModeState) slowModeState.textContent = ircDashboardState.suppressedChatMessages ? `Slow mode active · ${ircDashboardState.suppressedChatMessages} suppressed` : "Log slow mode ready";
  const selected = ircAccountSelect.value;
  const selectedChannel = ircChannelSelect.value;
  const selectedFilter = ircFilterSelect.value;
  const connected = accounts.filter((account) => account.status === "connected");
  ircAccountSelect.innerHTML = `<option value="">Select a joined account</option>${connected.map((account) => `<option value="${account.id}">${escapeHtml(account.name || `Account ${account.id}`)}${account.joined ? ` · #${escapeHtml(account.channel)}` : " · not joined"}</option>`).join("")}`;
  if ([...ircAccountSelect.options].some((option) => option.value === selected)) ircAccountSelect.value = selected;
  const channels = [...new Set([
    ...connected.filter((account) => account.joined && account.channel).map((account) => account.channel.toLowerCase()),
    ...ircDashboardState.events.filter((event) => event.channel).map((event) => String(event.channel).replace(/^#/, "").toLowerCase()),
  ])].sort();
  ircChannelSelect.innerHTML = `<option value="">All channels</option>${channels.map((channel) => `<option value="${escapeHtml(channel)}">#${escapeHtml(channel)}</option>`).join("")}`;
  if ([...ircChannelSelect.options].some((option) => option.value === selectedChannel)) ircChannelSelect.value = selectedChannel;
  ircFilterSelect.value = selectedFilter || "all";
  ircSlowModeToggle.checked = ircDashboardState.slowMode;
  const statusAccounts = connected.filter((account) => account.joined || ircDashboardState.statuses.has(account.id));
  ircStatusGrid.innerHTML = statusAccounts.length ? statusAccounts.map((account) => {
    const status = ircDashboardState.statuses.get(account.id) || { status: account.joined ? "joined" : "connected", channel: account.channel };
    return `<article class="irc-status-card"><strong>${escapeHtml(account.name || `Account ${account.id}`)}</strong><span class="irc-status-label ${status.status === "joined" ? "active" : ""}">${escapeHtml(status.status)}</span><small>${status.channel ? `#${escapeHtml(status.channel)}` : "No channel"}</small></article>`;
  }).join("") : `<div class="empty-state">Join a channel from Accounts to see IRC status here.</div>`;
  const filter = ircChannelSelect.value;
  const messageFilter = ircFilterSelect.value;
  const events = ircDashboardState.events.filter((event) => {
    if (filter && String(event.channel || "").replace(/^#/, "").toLowerCase() !== filter) return false;
    if (messageFilter === "system") return event.command !== "PRIVMSG";
    if (messageFilter === "mentions") return event.command === "PRIVMSG" && /@[a-z0-9_]+/i.test(event.text || "");
    if (messageFilter === "commands") return event.command === "PRIVMSG" && /^\s*![a-z0-9_-]+/i.test(event.text || "");
    if (messageFilter === "redemptions") return /redemption|redeem|reward|channel\s*points/i.test(`${event.command} ${event.text || ""} ${JSON.stringify(event.tags || {})}`);
    return event.command === "PRIVMSG" || event.command === "CHAT SLOW MODE";
  });
  ircLog.innerHTML = events.length ? events.map((event) => {
    const account = accounts.find((item) => item.id === Number(event.accountId));
    const detail = event.command === "PRIVMSG" ? `${event.user || "user"}: ${event.text}` : `${event.command}${event.text ? ` · ${event.text}` : ""}`;
    return `<article class="irc-log-entry"><div><strong>${escapeHtml(account?.name || `Account ${event.accountId}`)}</strong><span>${new Date(event.observedAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div><p>${escapeHtml(detail)}</p></article>`;
  }).join("") : `<div class="empty-state">IRC activity will appear here after an account joins chat.</div>`;
}

function setLastAction(text) {
  document.querySelector("#lastAction").textContent = text;
}

function renderProfileStats() {
  const activeAccounts = accounts.filter((account) => account.status === "connected");
  if (!activeAccounts.length) {
    profileStatsGrid.innerHTML = `<div class="empty-state">Connect an account and join a channel to see its profile stats.</div>`;
    return;
  }
  profileStatsGrid.innerHTML = activeAccounts.map((account) => {
    const status = account.joined ? "Joined" : "Connected, not joined";
    const points = account.points === null ? "Waiting for monitor" : account.points.toLocaleString();
    const pointsTime = account.pointsUpdatedAt ? `Updated ${new Date(account.pointsUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Extension not linked";
    return `<article class="profile-stat-card">
      <div class="profile-stat-heading">
        ${account.channelIcon ? `<img class="channel-icon" src="${escapeHtml(account.channelIcon)}" alt="" />` : `<span class="channel-icon channel-icon-placeholder"></span>`}
        <span class="account-number">${account.id}</span>
        <div><strong>${escapeHtml(account.name || `Account ${account.id}`)}</strong><small>${escapeHtml(account.profile)}</small></div>
        <span class="profile-stat-status ${account.joined ? "active" : ""}">${status}</span>
      </div>
      <dl class="profile-stat-list">
        <div><dt>Channel</dt><dd>${account.channel ? `#${escapeHtml(account.channel)}` : "None"}</dd></div>
        <div><dt>Authorization</dt><dd>${account.authorized ? "Stored" : "Not authorized"}</dd></div>
        <div><dt>Channel points</dt><dd>${points}</dd></div>
      </dl>
      <div class="profile-stat-actions">
        <small class="points-time">${pointsTime}</small>
        <button class="button secondary" data-action="monitor-points" data-id="${account.id}" type="button" ${account.channel ? "" : "disabled"}>${account.monitorLinked ? "Open monitor" : "Set up monitor"}</button>
        <button class="button secondary" data-action="open-profile-stat" data-id="${account.id}" type="button" ${account.channel ? "" : "disabled"}>Open channel</button>
      </div>
    </article>`;
  }).join("");
}

function selectSection(sectionId) {
  document.querySelectorAll(".section-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.section === sectionId));
  document.querySelectorAll(".app-section").forEach((section) => section.classList.toggle("active-section", section.id === sectionId));
}

function openConnectDialog(id) {
  const account = accounts.find((item) => item.id === id);
  selectedAccountId = id;
  dialogTitle.textContent = `Connect account ${id}`;
  accountNameInput.value = account.name;
  browserProfileInput.value = account.profile;
  connectDialog.showModal();
  setTimeout(() => accountNameInput.focus(), 0);
}

async function connectAccount() {
  const account = accounts.find((item) => item.id === selectedAccountId);
  const name = accountNameInput.value.trim();
  const profile = browserProfileInput.value.trim() || `Profile ${account.id}`;
  if (!name) return;
  account.name = name;
  account.profile = profile;
  account.status = "connected";
  account.channel = "";
  account.joined = false;
  account.monitorLinked = false;
  account.points = null;
  account.pointsUpdatedAt = "";
  saveAccounts();
  renderAccounts();
  setSystemState("working", "Opening Chrome");
  setLastAction(`${name} connected`);
  if (window.desktopBridge) {
    const result = await window.desktopBridge.openChromeProfile(account.id, "");
    if (!result.ok) {
      setSystemState("error", "Action failed");
      addDiagnostic("error", `${name}: ${result.error}`);
    } else {
      setSystemState("ready", "Ready");
      addDiagnostic("success", `${name} connected. Chrome opened in isolated account-${account.id} profile storage.`);
    }
  } else {
    setSystemState("ready", "Ready");
    addDiagnostic("info", `${name} connected in browser mode. Package the app as the EXE to launch isolated Chrome profiles.`);
  }
  selectedAccountId = null;
}

function disconnectAccount(id) {
  const account = accounts.find((item) => item.id === id);
  if (account.joined) {
    account.joined = false;
    addDiagnostic("info", `${account.name} parted ${account.channel ? `#${account.channel}` : "the active channel"} before disconnecting.`);
  }
  const name = account.name;
  account.name = "";
  account.profile = `Profile ${id}`;
  account.channel = "";
  account.status = "disconnected";
  account.monitorLinked = false;
  account.points = null;
  account.pointsUpdatedAt = "";
  saveAccounts();
  renderAccounts();
  setSystemState("ready", "Ready");
  setLastAction(`${name} disconnected`);
  addDiagnostic("success", `${name} is now disconnected.`);
}

function openJoinDialog(id) {
  const account = accounts.find((item) => item.id === id);
  if (account.status !== "connected") {
    setSystemState("error", "Action failed");
    setLastAction("Join failed");
    addDiagnostic("error", `Account ${id} is disconnected. Connect the account before joining a channel.`);
    return;
  }
  selectedJoinAccountId = id;
  channelDialogTitle.textContent = `Join channel as ${account.name}`;
  channelNameInput.value = account.channel;
  channelDialog.showModal();
  setTimeout(() => channelNameInput.focus(), 0);
}

function openAuthDialog(id) {
  const account = accounts.find((item) => item.id === id);
  selectedAuthAccountId = id;
  authDialogTitle.textContent = account.name ? `Authorize ${account.name}` : `Authorize account ${id}`;
  clientIdInput.value = account.clientId || localStorage.getItem("twitch-channel-control.client-id") || "";
  redirectUriInput.value = localStorage.getItem("twitch-channel-control.redirect-uri") || "http://localhost:47831/oauth/callback";
  authDialog.showModal();
  setTimeout(() => clientIdInput.focus(), 0);
}

async function authorizeAccount(id, clientId, redirectUri) {
  const account = accounts.find((item) => item.id === id);
  account.clientId = clientId;
  localStorage.setItem("twitch-channel-control.client-id", clientId);
  localStorage.setItem("twitch-channel-control.redirect-uri", redirectUri);
  saveAccounts();
  if (!window.desktopBridge) {
    addDiagnostic("error", "Twitch authorization requires the packaged desktop app.");
    return;
  }
  const auth = await window.desktopBridge.startTwitchAuth(id, clientId, redirectUri);
  if (!auth.ok) {
    setSystemState("error", "Authorization failed");
    addDiagnostic("error", auth.error);
    return;
  }
  const browser = await window.desktopBridge.openAuthInProfile(id, auth.authUrl);
  if (!browser.ok) {
    setSystemState("error", "Authorization failed");
    addDiagnostic("error", browser.error);
    return;
  }
  setLastAction(`Authorization opened for account ${id}`);
  addDiagnostic("info", `Twitch authorization opened in the isolated Chrome profile for ${account.name || `account ${id}`} with chat:read and chat:edit.`);
}

async function openBetterTtvForAccount(id) {
  const account = accounts.find((item) => item.id === id);
  if (!window.desktopBridge) {
    addDiagnostic("error", "BetterTTV profile launching requires the packaged desktop app.");
    return;
  }
  const result = await window.desktopBridge.openBetterTtvInProfile(id);
  if (!result.ok) {
    setSystemState("error", "Action failed");
    addDiagnostic("error", `${account.name || `Account ${id}`}: ${result.error}`);
    return;
  }
  setLastAction(`BetterTTV opened for account ${id}`);
  addDiagnostic("info", `BetterTTV opened in the isolated Chrome profile for ${account.name || `account ${id}`}.`);
}

async function openJoinedChannel(id) {
  const account = accounts.find((item) => item.id === id);
  if (!account.channel) {
    addDiagnostic("error", `${account.name || `Account ${id}`} has no saved channel.`);
    return;
  }
  if (!window.desktopBridge) {
    addDiagnostic("error", "Profile launching requires the packaged desktop app.");
    return;
  }
  const result = await window.desktopBridge.openChromeProfile(id, account.channel, true);
  if (!result.ok) {
    setSystemState("error", "Action failed");
    addDiagnostic("error", `${account.name || `Account ${id}`}: ${result.error}`);
    return;
  }
  setLastAction(`${account.name || `Account ${id}`} opened #${account.channel}`);
  addDiagnostic("info", `#${account.channel} opened in the isolated Chrome profile for ${account.name || `account ${id}`}.`);
}

async function joinChannel(id, channel) {
  const account = accounts.find((item) => item.id === id);
  const normalized = channel.trim().replace(/^#/, "").toLowerCase();
  if (!normalized) {
    setSystemState("error", "Action failed");
    setLastAction("Join failed");
    addDiagnostic("error", `${account.name}: channel name cannot be empty.`);
    return;
  }
  if (window.desktopBridge) {
    setSystemState("working", "Joining chat");
    const irc = await window.desktopBridge.joinIrc(account.id, normalized);
    if (!irc.ok) {
      setSystemState("error", "Action failed");
      setLastAction(`${account.name} could not join #${normalized}`);
      addDiagnostic(irc.code === "OFFLINE" ? "info" : "error", `${account.name}: ${irc.error}`);
      return;
    }
    account.channel = normalized;
    account.joined = true;
    saveAccounts();
    renderAccounts();
    setLastAction(`${account.name} joined #${normalized}`);
    const result = await window.desktopBridge.openChromeProfile(account.id, normalized, true);
    if (!result.ok) addDiagnostic("warning", `${account.name} joined IRC, but the browser could not open: ${result.error}`);
    setSystemState("ready", "Ready");
    addDiagnostic("success", `${account.name} joined IRC chat in #${normalized}. The connection remains active if Chrome closes.`);
  } else {
    account.channel = normalized;
    account.joined = true;
    saveAccounts();
    renderAccounts();
    setSystemState("ready", "Ready");
    addDiagnostic("info", `${account.name} joined #${normalized} locally. Package the app as the EXE to enable IRC.`);
  }
}

async function partChannel(id) {
  const account = accounts.find((item) => item.id === id);
  if (!account.joined) {
    setSystemState("error", "Action failed");
    setLastAction("Part failed");
    addDiagnostic("error", `${account.name || `Account ${id}`} is not currently in a channel.`);
    return;
  }
  const channel = account.channel;
  if (window.desktopBridge) await window.desktopBridge.partIrc(account.id);
  account.joined = false;
  saveAccounts();
  renderAccounts();
  setSystemState("ready", "Ready");
  setLastAction(`${account.name} parted #${channel}`);
  addDiagnostic("success", `${account.name} parted #${channel}.`);
}

accountList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  const id = Number(button.dataset.id);
  const action = button.dataset.action;
  if (action === "connect") openConnectDialog(id);
  if (action === "disconnect") disconnectAccount(id);
  if (action === "authorize") openAuthDialog(id);
  if (action === "betterttv") openBetterTtvForAccount(id);
  if (action === "open-channel") openJoinedChannel(id);
  if (action === "join") openJoinDialog(id);
  if (action === "part") partChannel(id);
});

profileStatsGrid.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action=\"open-profile-stat\"]");
  if (!button || button.disabled) return;
  openJoinedChannel(Number(button.dataset.id));
});

profileStatsGrid.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action=\"monitor-points\"]");
  if (!button || button.disabled || !window.desktopBridge?.installPointsMonitor) return;
  const account = accounts.find((item) => item.id === Number(button.dataset.id));
  if (!account) return;
  const result = await window.desktopBridge.installPointsMonitor(account.id, account.channel);
  if (!result.ok) {
    addDiagnostic("error", result.error || "The points monitor could not be started.");
    return;
  }
  account.monitorLinked = true;
  saveAccounts();
  renderProfileStats();
  setLastAction(`Points monitor opened for ${account.name}`);
  addDiagnostic("info", `${account.name}: install the unpacked extension from ${result.extensionPath}, then reload the Twitch tab if Chrome did not load it automatically.`);
});

connectForm.addEventListener("submit", (event) => {
  if (event.submitter?.value === "default") {
    event.preventDefault();
    connectAccount();
    connectDialog.close();
  }
});

channelForm.addEventListener("submit", (event) => {
  if (event.submitter?.value === "default") {
    event.preventDefault();
    const id = selectedJoinAccountId;
    const channel = channelNameInput.value;
    channelDialog.close();
    selectedJoinAccountId = null;
    if (id !== null) joinChannel(id, channel);
  }
});

authForm.addEventListener("submit", (event) => {
  if (event.submitter?.value === "default") {
    event.preventDefault();
    const id = selectedAuthAccountId;
    const clientId = clientIdInput.value.trim();
    const redirectUri = redirectUriInput.value.trim();
    if (!clientId || !redirectUri || id === null) return;
    authDialog.close();
    selectedAuthAccountId = null;
    authorizeAccount(id, clientId, redirectUri);
  }
});

if (window.desktopBridge?.onTwitchAuthComplete) {
  window.desktopBridge.onTwitchAuthComplete(({ accountId, scope }) => {
    const account = accounts.find((item) => item.id === accountId);
    if (!account) return;
    account.authorized = true;
    saveAccounts();
    renderAccounts();
    setSystemState("ready", "Ready");
    setLastAction(`${account.name || `Account ${accountId}`} authorized`);
    addDiagnostic("success", `${account.name || `Account ${accountId}`} authorization token stored securely. Granted scopes: ${scope || "chat:read chat:edit"}.`);
  });
}

if (window.desktopBridge?.onIrcStatus) {
  window.desktopBridge.onIrcStatus(({ accountId, status, channel, error }) => {
    const account = accounts.find((item) => item.id === accountId);
    if (!account) return;
    ircDashboardState.statuses.set(accountId, { status, channel, error });
    addIrcEvent({ accountId, command: "IRC STATUS", text: error || status, observedAt: new Date().toISOString() });
    if (status === "joined") {
      account.channel = channel;
      account.joined = true;
      saveAccounts();
      renderAccounts();
      return;
    }
    if (["parted", "disconnected", "error"].includes(status)) {
      account.joined = false;
      saveAccounts();
      renderAccounts();
      setSystemState(status === "error" ? "error" : "ready", status === "error" ? "IRC error" : "Ready");
      setLastAction(`${account.name || `Account ${accountId}`} left #${channel}`);
      return;
    }
  });
}

if (window.desktopBridge?.onIrcEvent) {
  window.desktopBridge.onIrcEvent((event) => {
    if (!event || !Number.isInteger(Number(event.accountId))) return;
    addIrcEvent({ ...event, accountId: Number(event.accountId) });
  });
}

if (window.desktopBridge?.onPointsUpdate) {
  window.desktopBridge.onPointsUpdate(({ accountId, channel, points, observedAt }) => {
    const account = accounts.find((item) => item.id === accountId);
    if (!account) return;
    account.points = points;
    account.pointsUpdatedAt = observedAt;
    account.monitorLinked = true;
    if (channel) account.channel = channel;
    saveAccounts();
    renderAccounts();
    renderProfileStats();
    if (account.lastDiagnosticPoints !== points) {
      account.lastDiagnosticPoints = points;
      addDiagnostic("success", `${account.name || `Account ${accountId}`}: monitor update received${points === null ? " but Twitch did not expose a points balance" : ` (${points.toLocaleString()} points)`}.`);
    }
  });
}

document.querySelector("#clearLog").addEventListener("click", () => {
  clearDiagnostics();
});

document.querySelector("#clearIrcLog").addEventListener("click", () => {
  ircDashboardState.events.length = 0;
  ircDashboardState.seenChatMessages.clear();
  ircDashboardState.suppressedChatMessages = 0;
  ircDashboardState.slowModeUntil = 0;
  ircDashboardState.lastChatEventAt = 0;
  ircDashboardState.slowModeNoticeShown = false;
  if (ircDashboardState.slowModeTimer) window.clearTimeout(ircDashboardState.slowModeTimer);
  ircDashboardState.slowModeTimer = null;
  renderIrcDashboard();
});

ircAccountSelect.addEventListener("change", renderIrcDashboard);
ircChannelSelect.addEventListener("change", renderIrcDashboard);
ircFilterSelect.addEventListener("change", renderIrcDashboard);
ircSlowModeToggle.addEventListener("change", () => {
  ircDashboardState.slowMode = ircSlowModeToggle.checked;
  appSettings.ircSlowMode = ircDashboardState.slowMode;
  saveSettings();
  if (!ircDashboardState.slowMode) {
    if (ircDashboardState.slowModeTimer) window.clearTimeout(ircDashboardState.slowModeTimer);
    ircDashboardState.slowModeTimer = null;
    ircDashboardState.suppressedChatMessages = 0;
    ircDashboardState.slowModeUntil = 0;
    ircDashboardState.slowModeNoticeShown = false;
  }
  renderIrcDashboard();
});
ircMessageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const accountId = Number(ircAccountSelect.value);
  const message = ircMessageInput.value.trim();
  if (!accountId || !message || !window.desktopBridge?.sendIrcMessage) return;
  const result = await window.desktopBridge.sendIrcMessage(accountId, message);
  if (!result.ok) {
    addIrcEvent({ accountId, command: "SEND ERROR", text: result.error || "The message could not be sent.", observedAt: new Date().toISOString() });
    return;
  }
  ircMessageInput.value = "";
});

document.querySelector("#betterTtvButton").addEventListener("click", async () => {
  const url = "https://chromewebstore.google.com/detail/betterttv/ajopnjidmegmdimjlfnijceegpefgped";
  if (window.desktopBridge) {
    const result = await window.desktopBridge.openExternal(url);
    if (!result.ok) {
      setSystemState("error", "Action failed");
      addDiagnostic("error", result.error);
      return;
    }
    addDiagnostic("info", "BetterTTV installation page opened in your default browser.");
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
});

document.querySelector("#detailedGuideButton").addEventListener("click", () => guideDialog.showModal());

document.querySelector("#backupButton").addEventListener("click", async () => {
  if (!window.desktopBridge?.createBackup) return;
  const result = await window.desktopBridge.createBackup(cacheSnapshot());
  if (!result.ok) {
    addDiagnostic("error", result.error || "Backup failed.");
    return;
  }
  addDiagnostic("success", `Backup created at ${result.path} with ${result.accountCount || 0} cached account${result.accountCount === 1 ? "" : "s"}.`);
  setLastAction("Emergency backup created");
});

document.querySelector("#restoreBackupButton").addEventListener("click", async () => {
  if (!window.desktopBridge?.restoreBackup) return;
  const result = await window.desktopBridge.restoreBackup();
  if (result.cancelled) return;
  if (!result.ok) {
    addDiagnostic("error", result.error || "Restore failed.");
    return;
  }
  const restoredAccounts = Array.isArray(result.cache?.accounts) ? result.cache.accounts : [];
  const restoredSettings = result.cache?.settings && typeof result.cache.settings === "object" ? result.cache.settings : {};
  localStorage.setItem(accountCacheKey, JSON.stringify(restoredAccounts));
  localStorage.setItem(settingsKey, JSON.stringify(restoredSettings));
  if (window.desktopBridge.saveAccountCache) {
    const cacheResult = await window.desktopBridge.saveAccountCache(restoredAccounts);
    if (!cacheResult.ok) {
      addDiagnostic("error", cacheResult.error || "The durable account cache could not be restored.");
      return;
    }
  }
  addDiagnostic("success", `Backup restored from ${result.path} with ${restoredAccounts.length} cached account${restoredAccounts.length === 1 ? "" : "s"}.`);
  setLastAction("Backup restored");
  if (result.restartScheduled && window.desktopBridge.quitForRestore) {
    setTimeout(() => window.desktopBridge.quitForRestore(), 500);
  } else {
    setTimeout(() => window.location.reload(), 500);
  }
});

document.querySelectorAll(".section-tab").forEach((tab) => {
  tab.addEventListener("click", () => selectSection(tab.dataset.section));
});

trayToggle.addEventListener("change", async () => {
  appSettings.trayMode = trayToggle.checked;
  saveSettings();
  if (!window.desktopBridge?.setTrayMode) return;
  const result = await window.desktopBridge.setTrayMode(appSettings.trayMode);
  if (!result.ok) {
    trayToggle.checked = false;
    appSettings.trayMode = false;
    saveSettings();
    addDiagnostic("error", result.error || "Windows tray mode could not be enabled.");
    return;
  }
  addDiagnostic("success", `Windows tray mode ${appSettings.trayMode ? "enabled" : "disabled"}.`);
});

hardwareAccelerationToggle.addEventListener("change", async () => {
  const enabled = hardwareAccelerationToggle.checked;
  appSettings.hardwareAcceleration = enabled;
  saveSettings();
  const result = await window.desktopBridge.setHardwareAcceleration(enabled);
  if (!result.ok) { hardwareAccelerationToggle.checked = !enabled; appSettings.hardwareAcceleration = !enabled; saveSettings(); addDiagnostic("error", result.error || "Hardware acceleration setting could not be saved."); return; }
  addDiagnostic("info", `Hardware acceleration ${enabled ? "enabled" : "disabled"}. Restart the app to apply it.`);
});

async function checkForUpdates(showCurrent = true) {
  if (!window.desktopBridge?.checkForUpdates) return;
  checkForUpdatesButton.disabled = true;
  updateStatus.textContent = "Checking GitHub for a newer release...";
  const result = await window.desktopBridge.checkForUpdates();
  checkForUpdatesButton.disabled = false;
  if (!result.ok) {
    updateStatus.textContent = `Update check failed: ${result.error}`;
    addDiagnostic("warning", `Update check failed: ${result.error}`);
    return;
  }
  if (result.available) {
    updateStatus.textContent = `Version ${result.version} is available.`;
    addDiagnostic("success", `Version ${result.version} is available on GitHub.`);
    if (window.confirm(`Twitch Channel Control ${result.version} is available. Open the GitHub release page?`)) {
      window.desktopBridge.openExternal(result.url);
    }
  } else if (showCurrent) {
    updateStatus.textContent = `You are using the latest version (${result.currentVersion}).`;
    addDiagnostic("success", `Update check complete: version ${result.currentVersion} is current.`);
  }
}

function renderUpdateStatus(update) {
  if (!update) return;
  if (update.status === "available") {
    updateStatus.textContent = `Version ${update.version} is available. Choose Download update.`;
    downloadUpdateButton.hidden = false;
    installUpdateButton.hidden = true;
  } else if (update.status === "downloading") {
    updateStatus.textContent = `Downloading update... ${update.percent || 0}%`;
    downloadUpdateButton.hidden = true;
  } else if (update.status === "downloaded") {
    updateStatus.textContent = `Version ${update.version} is ready to install.`;
    downloadUpdateButton.hidden = true;
    installUpdateButton.hidden = false;
  } else if (update.status === "current") {
    updateStatus.textContent = `You are using the latest version (${update.version}).`;
  } else if (update.status === "error") {
    updateStatus.textContent = `Update error: ${update.error}`;
    addDiagnostic("warning", `Update error: ${update.error}`);
  }
}

window.desktopBridge?.onUpdateStatus(renderUpdateStatus);
downloadUpdateButton?.addEventListener("click", async () => {
  downloadUpdateButton.disabled = true;
  const result = await window.desktopBridge.downloadUpdate();
  if (!result.ok) {
    downloadUpdateButton.disabled = false;
    updateStatus.textContent = result.error;
    addDiagnostic("warning", result.error);
  }
});
installUpdateButton?.addEventListener("click", () => window.desktopBridge.installUpdate());

checkForUpdatesButton?.addEventListener("click", () => checkForUpdates(true));

openArcadeWindowButton?.addEventListener("click", () => window.desktopBridge.openArcadeWindow());

loadSettings();
loadChannelProfiles();
ircDashboardState.slowMode = appSettings.ircSlowMode;
trayToggle.checked = appSettings.trayMode;
hardwareAccelerationToggle.checked = appSettings.hardwareAcceleration;
loadAccounts();
renderAccounts();
renderProfileStats();
diagnosticList.innerHTML = `<div class="empty-state">Actions, connection changes, and errors will appear here.</div>`;
window.setInterval(clearDiagnostics, 60 * 60 * 1000);
renderIrcDashboard();
if (window.desktopBridge?.setTrayMode) window.desktopBridge.setTrayMode(appSettings.trayMode);
setTimeout(() => checkForUpdates(false), 2500);
window.desktopBridge?.getAppVersion?.().then((version) => { if (!updateStatus.textContent.includes("available") && !updateStatus.textContent.includes("latest")) updateStatus.textContent = `Installed version: ${version}. Checking for updates...`; });
if (accounts.some((account) => account.status === "connected")) {
  const restored = accounts.filter((account) => account.status === "connected").length;
  setLastAction(`${restored} cached account${restored === 1 ? "" : "s"} restored`);
}
hydrateAccountsFromDisk();
refreshSelectedChannelProfiles();
