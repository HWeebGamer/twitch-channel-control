let lastPayload = "";

function parsePoints(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!/points/i.test(normalized)) return null;

  // The balance may be written as 1,234, 1.2K, or be separated from the
  // label by nested elements in Twitch's React tree.
  const match = normalized.match(/(?:channel\s*points|points)\s*[:\-]?\s*([\d,.]+\s*[KMB]?)|([\d,.]+\s*[KMB]?)\s*(?:channel\s*points|points)/i);
  let value = match?.[1] || match?.[2];
  if (!value) {
    const numbers = normalized.match(/\b\d[\d,.]*(?:\s*[KMB])?\b/gi);
    value = numbers?.at(-1) || "";
  }
  if (!value) return null;
  const compact = value.replace(/\s+/g, "").replace(/,/g, "");
  const suffix = compact.slice(-1).toUpperCase();
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  const number = suffix === "K" || suffix === "M" || suffix === "B" ? compact.slice(0, -1) : compact;
  const points = Math.round(Number(number) * multiplier);
  return Number.isSafeInteger(points) && points >= 0 ? points : null;
}

function findVisiblePoints() {
  // Twitch changes the points button markup frequently. Check the stable-ish
  // target attributes first, then fall back to accessible labels and nearby text.
  const priority = document.querySelectorAll([
    "[data-a-target='channel-points-button']",
    "[data-a-target*='channel-points' i]",
    "[data-test-selector*='channel-points' i]",
    "[aria-label*='channel points' i]",
    "[title*='channel points' i]",
    "[class*='channel-points' i]",
    "[class*='community-points' i]",
    "[aria-label*='points' i]",
    "[title*='points' i]",
  ].join(","));
  for (const element of priority) {
    const points = parsePoints([
      element.getAttribute("aria-label") || "",
      element.getAttribute("title") || "",
      element.getAttribute("data-a-target") || "",
      element.textContent || "",
    ].join(" "));
    if (points !== null) return points;
  }

  // Some layouts put the number in a child span while the parent only has an
  // icon. Limit this fallback to elements whose accessible metadata mentions
  // points so ordinary viewer counts are not mistaken for channel points.
  const labelled = document.querySelectorAll("button, [role='button'], [aria-label], [title]");
  for (const element of labelled) {
    const label = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`;
    if (!/points/i.test(label)) continue;
    const points = parsePoints(`${label} ${element.textContent || ""}`);
    if (points !== null) return points;
  }
  return null;
}

function sendUpdate() {
  const channel = location.pathname.split("/").filter(Boolean)[0]?.toLowerCase() || "";
  if (!channel || ["directory", "search", "videos", "settings"].includes(channel)) return;
  const points = findVisiblePoints();
  const slotId = new URLSearchParams(location.search).get("alt_monitor_slot") || "";
  const payload = JSON.stringify({ type: "points-update", slotId, channel, points, observedAt: new Date().toISOString() });
  if (payload === lastPayload) return;
  lastPayload = payload;
  chrome.runtime.sendMessage(JSON.parse(payload));
}

sendUpdate();
const observer = new MutationObserver(() => sendUpdate());
observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
window.setInterval(sendUpdate, 5000);
