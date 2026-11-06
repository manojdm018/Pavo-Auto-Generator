const KEY = "pavoQueueState";
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(KEY);
  if (!data[KEY]) await chrome.storage.local.set({[KEY]: {
    running: false, paused: false, completed: 0, status: "Ready", updatedAt: Date.now()
  }});
});
