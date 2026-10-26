const monitorEndpoint = "http://localhost:47831/points/update";

async function getProfileId() {
  const stored = await chrome.storage.local.get("profileId");
  if (stored.profileId) return stored.profileId;
  const profileId = crypto.randomUUID();
  await chrome.storage.local.set({ profileId });
  return profileId;
}

chrome.runtime.onInstalled.addListener(() => {
  getProfileId();
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "points-update") return;
  getProfileId().then((profileId) => fetch(monitorEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...message, profileId, tabUrl: sender.tab?.url || "" }),
  })).catch(() => {
    // The desktop app may not be running yet; the next DOM update will retry.
  });
});
