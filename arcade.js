let folder = localStorage.getItem("anon-tw-folder") || "";
const download = document.querySelector("#downloadArcadeButton");
const select = document.querySelector("#selectArcadeFolderButton");
const launch = document.querySelector("#launchArcadeButton");
const status = document.querySelector("#arcadeStatus");
if (folder) status.textContent = `Selected: ${folder}`;
if (folder) launch.disabled = false;
download.addEventListener("click", () => window.desktopBridge.openExternal("https://gitgud.io/Legis1998/anon-tw/-/archive/anon-tw_eng-modding/anon-tw-anon-tw_eng-modding.zip"));
select.addEventListener("click", async () => { const result = await window.desktopBridge.selectArcadeFolder(); if (!result.ok) return; folder = result.folder; localStorage.setItem("anon-tw-folder", folder); status.textContent = `Selected: ${folder}`; launch.disabled = false; });
launch.addEventListener("click", async () => { launch.disabled = true; const result = await window.desktopBridge.launchArcadeGame(folder); status.textContent = result.ok ? result.message : `Launch error: ${result.error}`; launch.disabled = false; });

const canvas = document.querySelector("#snakeCanvas");
addBackgroundControl(document.querySelector(".snake-stage"), "arcade-snake-background", "Snake");
const context = canvas.getContext("2d");
const originalSnakeFillRect = context.fillRect.bind(context);
context.fillRect = (...args) => { if (args[0] === 0 && args[1] === 0 && args[2] === canvas.width && args[3] === canvas.height) { context.clearRect(0, 0, canvas.width, canvas.height); return; } originalSnakeFillRect(...args); };
const scoreLabel = document.querySelector("#snakeScore");
const bestLabel = document.querySelector("#snakeBest");
const boardSizeSelect = document.querySelector("#snakeBoardSize");
const iconTargetsToggle = document.querySelector("#arcadeIconTargets");
const snakeTargetSelect = document.querySelector("#snakeTargetChannel");
const targetProfileKey = "arcade-target-profile";
const overlay = document.querySelector("#snakeOverlay");
const overlayTitle = document.querySelector("#snakeOverlayTitle");
const overlayText = document.querySelector("#snakeOverlayText");
const startButton = document.querySelector("#snakeStartButton");
const restartButton = document.querySelector("#snakeRestartButton");
const boardPixels = { 10: 400, 15: 480, 20: 560 };
let cells = [10, 15, 20].includes(Number(localStorage.getItem("snake-board-size"))) ? Number(localStorage.getItem("snake-board-size")) : 15;
let cellSize = 0;
function addBackgroundControl(stage, key, label) { const row = document.createElement("div"); row.className = "arcade-background-control"; row.innerHTML = `<input type="url" placeholder="Imgur background URL" aria-label="${label} Imgur background URL"><button class="button secondary" type="button">Apply</button><button class="button secondary" type="button">Clear</button>`; const input = row.querySelector("input"); const saved = localStorage.getItem(key) || ""; input.value = saved; const apply = () => { const url = input.value.trim(); if (url && !/^https?:\/\/(?:i\.)?imgur\.com\//i.test(url)) return; localStorage.setItem(key, url); stage.style.backgroundImage = url ? `linear-gradient(rgba(11, 11, 16, .55), rgba(11, 11, 16, .55)), url("${url.replace(/"/g, "")}")` : ""; stage.style.backgroundSize = "cover"; stage.style.backgroundPosition = "center"; }; row.querySelectorAll("button")[0].addEventListener("click", apply); row.querySelectorAll("button")[1].addEventListener("click", () => { input.value = ""; localStorage.removeItem(key); apply(); }); stage.before(row); apply(); }
let snake; let food; let direction; let nextDirection; let score; let timer; let running = false;
let targetImage = null;
const channelProfileCacheKey = "twitch-channel-control.channel-profiles.v1";

function loadTargetImage() {
  targetImage = null;
  if (!iconTargetsToggle.checked) return;
  try {
    const profiles = JSON.parse(localStorage.getItem(channelProfileCacheKey) || "{}");
    const selected = profiles[localStorage.getItem(targetProfileKey)] || Object.values(profiles).find((profile) => profile?.profileImageUrl);
    const url = selected?.profileImageUrl;
    if (!url) return;
    const image = new Image();
    image.onload = () => { targetImage = image; drawSnake(); };
    image.src = url;
  } catch (error) { targetImage = null; }
}

function bestKey() { return `snake-best-${cells}`; }
function updateBest() { const best = Number(localStorage.getItem(bestKey())) || 0; bestLabel.textContent = best; return best; }
function placeFood() { do { food = { x: Math.floor(Math.random() * cells), y: Math.floor(Math.random() * cells) }; } while (snake.some((part) => part.x === food.x && part.y === food.y)); }
function resizeSnakeBoard() { const pixels = boardPixels[cells]; canvas.width = pixels; canvas.height = pixels; cellSize = pixels / cells; canvas.parentElement.style.setProperty("--snake-board-pixels", `${pixels}px`); }
function resetSnake() { clearInterval(timer); running = false; resizeSnakeBoard(); loadTargetImage(); const center = Math.floor(cells / 2); snake = [{ x: center, y: center }, { x: Math.max(0, center - 1), y: center }]; direction = { x: 1, y: 0 }; nextDirection = { ...direction }; score = 0; scoreLabel.textContent = score; updateBest(); placeFood(); overlayTitle.textContent = "Ready?"; overlayText.textContent = "Use the arrow keys or WASD to play."; startButton.textContent = "Start game"; overlay.hidden = false; drawSnake(); }
function drawSnake() { context.fillStyle = "#0b0b10"; context.fillRect(0, 0, canvas.width, canvas.height); context.strokeStyle = "rgba(157, 104, 255, .08)"; for (let i = 1; i < cells; i += 1) { context.beginPath(); context.moveTo(i * cellSize, 0); context.lineTo(i * cellSize, canvas.height); context.stroke(); context.beginPath(); context.moveTo(0, i * cellSize); context.lineTo(canvas.width, i * cellSize); context.stroke(); } if (targetImage) { context.save(); context.beginPath(); context.arc(food.x * cellSize + cellSize / 2, food.y * cellSize + cellSize / 2, Math.max(4, cellSize / 2 - 3), 0, Math.PI * 2); context.clip(); context.drawImage(targetImage, food.x * cellSize + 3, food.y * cellSize + 3, cellSize - 6, cellSize - 6); context.restore(); } else { context.fillStyle = "#ff5d78"; context.fillRect(food.x * cellSize + 4, food.y * cellSize + 4, cellSize - 8, cellSize - 8); } snake.forEach((part, index) => { context.fillStyle = index === 0 ? "#c99cff" : "#8d5be8"; context.fillRect(part.x * cellSize + 3, part.y * cellSize + 3, cellSize - 6, cellSize - 6); }); }
function setDirection(value) { const vectors = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }; const candidate = vectors[value]; if (!candidate || (candidate.x === -direction.x && candidate.y === -direction.y)) return; nextDirection = candidate; }
function tickSnake() { direction = nextDirection; const head = { x: snake[0].x + direction.x, y: snake[0].y + direction.y }; if (head.x < 0 || head.x >= cells || head.y < 0 || head.y >= cells || snake.some((part) => part.x === head.x && part.y === head.y)) { clearInterval(timer); running = false; const best = Number(localStorage.getItem(bestKey())) || 0; if (score > best) { localStorage.setItem(bestKey(), String(score)); updateBest(); } overlayTitle.textContent = "Game over"; overlayText.textContent = `Final score: ${score} on ${cells} × ${cells}`; startButton.textContent = "Play again"; overlay.hidden = false; return; } snake.unshift(head); if (head.x === food.x && head.y === food.y) { score += 1; scoreLabel.textContent = score; const best = Number(localStorage.getItem(bestKey())) || 0; if (score > best) { localStorage.setItem(bestKey(), String(score)); updateBest(); } placeFood(); } else snake.pop(); drawSnake(); }
function startSnake() { if (running) return; if (!overlay.hidden && overlayTitle.textContent === "Game over") resetSnake(); running = true; overlay.hidden = true; clearInterval(timer); timer = setInterval(tickSnake, 125); }
startButton.addEventListener("click", startSnake); restartButton.addEventListener("click", resetSnake); document.querySelectorAll("[data-snake-direction]").forEach((button) => button.addEventListener("click", () => setDirection(button.dataset.snakeDirection)));
document.addEventListener("keydown", (event) => { const keys = { ArrowUp: "up", w: "up", ArrowDown: "down", s: "down", ArrowLeft: "left", a: "left", ArrowRight: "right", d: "right" }; if (keys[event.key]) { event.preventDefault(); setDirection(keys[event.key]); if (!running) startSnake(); } });
boardSizeSelect.value = String(cells);
function populateTargetSelect(select) { const profiles = JSON.parse(localStorage.getItem(channelProfileCacheKey) || "{}"); const current = localStorage.getItem(targetProfileKey) || ""; select.innerHTML = `<option value="">Cached channel target</option>${Object.entries(profiles).filter(([, profile]) => profile?.profileImageUrl).map(([channel, profile]) => `<option value="${channel}">${profile.displayName || channel}</option>`).join("")}`; select.value = current; }
const flappyTargetSelect = document.createElement("select"); flappyTargetSelect.className = "channel-target-select"; flappyTargetSelect.setAttribute("aria-label", "Flappy Channel icon target"); flappyTargetSelect.id = "flappyTargetChannel"; document.querySelector("#flappyRestartButton").after(flappyTargetSelect);
populateTargetSelect(snakeTargetSelect); populateTargetSelect(flappyTargetSelect);
iconTargetsToggle.checked = localStorage.getItem("arcade-icon-targets") === "true";
const targetChanged = (event) => { localStorage.setItem(targetProfileKey, event.target.value); snakeTargetSelect.value = event.target.value; flappyTargetSelect.value = event.target.value; resetSnake(); resetFlappy(); };
snakeTargetSelect.addEventListener("change", targetChanged); flappyTargetSelect.addEventListener("change", targetChanged);
iconTargetsToggle.addEventListener("change", () => { localStorage.setItem("arcade-icon-targets", String(iconTargetsToggle.checked)); resetSnake(); resetFlappy(); });
boardSizeSelect.addEventListener("change", () => { cells = Number(boardSizeSelect.value); localStorage.setItem("snake-board-size", String(cells)); resetSnake(); });
resetSnake();

const flappyCanvas = document.querySelector("#flappyCanvas");
addBackgroundControl(document.querySelector(".flappy-stage"), "arcade-flappy-background", "Flappy Channel");
const flappyContext = flappyCanvas.getContext("2d");
const originalFlappyFillRect = flappyContext.fillRect.bind(flappyContext);
flappyContext.fillRect = (...args) => { if (args[0] === 0 && args[1] === 0 && args[2] === flappyCanvas.width && args[3] === flappyCanvas.height) { flappyContext.clearRect(0, 0, flappyCanvas.width, flappyCanvas.height); return; } originalFlappyFillRect(...args); };
const flappyOverlay = document.querySelector("#flappyOverlay");
const flappyOverlayTitle = document.querySelector("#flappyOverlayTitle");
const flappyOverlayText = document.querySelector("#flappyOverlayText");
const flappyStart = document.querySelector("#flappyStartButton");
const flappyRestart = document.querySelector("#flappyRestartButton");
const flappyBest = document.querySelector("#flappyBest");
let flappyBird; let flappyPipes; let flappyScore; let flappyTimer; let flappyRunning = false; let flappyImage = null;
const flappyBestKey = "flappy-channel-best";
function loadFlappyImage() { try { if (!iconTargetsToggle.checked) { flappyImage = null; return; } const profiles = JSON.parse(localStorage.getItem(channelProfileCacheKey) || "{}"); const selected = profiles[localStorage.getItem(targetProfileKey)] || Object.values(profiles).find((profile) => profile?.profileImageUrl); const image = new Image(); image.onload = () => { flappyImage = image; drawFlappy(); }; if (selected?.profileImageUrl) image.src = selected.profileImageUrl; else flappyImage = null; } catch (error) { flappyImage = null; } }
function resetFlappy() { clearInterval(flappyTimer); flappyRunning = false; flappyBird = { x: 125, y: 190, velocity: 0 }; flappyPipes = []; flappyScore = 0; flappyBest.textContent = localStorage.getItem(flappyBestKey) || "0"; flappyOverlayTitle.textContent = "Ready?"; flappyOverlayText.textContent = "Press Space or click to flap."; flappyStart.textContent = "Start game"; flappyOverlay.hidden = false; loadFlappyImage(); drawFlappy(); }
function addFlappyPipe() { const gap = 132; const top = 45 + Math.floor(Math.random() * 175); flappyPipes.push({ x: flappyCanvas.width + 20, top, gap, scored: false }); }
function drawFlappy() { flappyContext.fillStyle = "#0b0b10"; flappyContext.fillRect(0, 0, flappyCanvas.width, flappyCanvas.height); flappyContext.fillStyle = "rgba(157, 104, 255, .09)"; for (let x = 0; x < flappyCanvas.width; x += 40) flappyContext.fillRect(x, 0, 1, flappyCanvas.height); flappyContext.fillStyle = "#8d5be8"; flappyPipes?.forEach((pipe) => { flappyContext.fillRect(pipe.x, 0, 42, pipe.top); flappyContext.fillRect(pipe.x, pipe.top + pipe.gap, 42, flappyCanvas.height); }); flappyContext.fillStyle = "#17131e"; flappyContext.fillRect(0, flappyCanvas.height - 18, flappyCanvas.width, 18); if (flappyImage) flappyContext.drawImage(flappyImage, flappyBird.x - 18, flappyBird.y - 18, 36, 36); else { flappyContext.fillStyle = "#c99cff"; flappyContext.beginPath(); flappyContext.arc(flappyBird.x, flappyBird.y, 16, 0, Math.PI * 2); flappyContext.fill(); } }
function endFlappy() { clearInterval(flappyTimer); flappyRunning = false; const best = Number(localStorage.getItem(flappyBestKey)) || 0; if (flappyScore > best) { localStorage.setItem(flappyBestKey, String(flappyScore)); flappyBest.textContent = flappyScore; } flappyOverlayTitle.textContent = "Game over"; flappyOverlayText.textContent = `Final score: ${flappyScore}`; flappyStart.textContent = "Play again"; flappyOverlay.hidden = false; }
function tickFlappy() { flappyBird.velocity += 0.42; flappyBird.y += flappyBird.velocity; flappyPipes.forEach((pipe) => { pipe.x -= 3.2; if (!pipe.scored && pipe.x + 42 < flappyBird.x) { pipe.scored = true; flappyScore += 1; } }); if (!flappyPipes.length || flappyPipes[flappyPipes.length - 1].x < 360) addFlappyPipe(); const hitPipe = flappyPipes.some((pipe) => flappyBird.x + 14 > pipe.x && flappyBird.x - 14 < pipe.x + 42 && (flappyBird.y - 14 < pipe.top || flappyBird.y + 14 > pipe.top + pipe.gap)); if (flappyBird.y < 15 || flappyBird.y > flappyCanvas.height - 34 || hitPipe) { endFlappy(); return; } flappyPipes = flappyPipes.filter((pipe) => pipe.x > -60); drawFlappy(); }
function flap() { if (!flappyRunning) { if (!flappyOverlay.hidden && flappyOverlayTitle.textContent === "Game over") resetFlappy(); flappyRunning = true; flappyOverlay.hidden = true; clearInterval(flappyTimer); flappyTimer = setInterval(tickFlappy, 24); } flappyBird.velocity = -7; }
flappyStart.addEventListener("click", flap); flappyRestart.addEventListener("click", resetFlappy); flappyCanvas.addEventListener("click", flap); document.addEventListener("keydown", (event) => { if (event.code === "Space") { event.preventDefault(); flap(); } }); resetFlappy();

document.querySelectorAll(".snake-stage, .flappy-stage").forEach((stage) => {
  const syncBackgroundLayer = () => { const image = stage.style.backgroundImage; stage.style.setProperty("--arcade-bg-image", image || "none"); stage.style.backgroundImage = "none"; };
  syncBackgroundLayer();
});

function refreshSavedBackground(stage, key) {
  const url = localStorage.getItem(key) || "";
  const image = url ? `linear-gradient(rgba(11, 11, 16, .55), rgba(11, 11, 16, .55)), url("${url.replace(/"/g, "")}")` : "none";
  stage.style.setProperty("--arcade-bg-image", image);
  stage.style.backgroundImage = "none";
}
refreshSavedBackground(document.querySelector(".snake-stage"), "arcade-snake-background");
refreshSavedBackground(document.querySelector(".flappy-stage"), "arcade-flappy-background");
document.querySelectorAll(".arcade-background-control button").forEach((button) => button.addEventListener("click", () => setTimeout(() => {
  refreshSavedBackground(document.querySelector(".snake-stage"), "arcade-snake-background");
  refreshSavedBackground(document.querySelector(".flappy-stage"), "arcade-flappy-background");
}, 0)));

document.querySelectorAll("[data-arcade-toggle]").forEach((button) => {
  const panel = document.querySelector(`#${button.dataset.arcadeToggle}`);
  const key = `arcade-hidden-${button.dataset.arcadeToggle}`;
  const apply = (hidden) => { panel.hidden = hidden; document.querySelectorAll(`[data-arcade-toggle="${button.dataset.arcadeToggle}"]`).forEach((control) => { control.textContent = hidden ? `Show ${control.textContent.replace(/^Hide |^Show /, "")}` : `Hide ${control.textContent.replace(/^Hide |^Show /, "")}`; }); };
  apply(localStorage.getItem(key) === "true");
  button.addEventListener("click", () => { const hidden = !panel.hidden; localStorage.setItem(key, String(hidden)); apply(hidden); });
});
