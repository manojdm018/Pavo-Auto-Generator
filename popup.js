const $ = id => document.getElementById(id);
async function pavoTab() {
  const tabs = await chrome.tabs.query({active:true,currentWindow:true});
  return tabs.find(t => t.url?.startsWith("https://app.pavo-ai.work/")) || null;
}
function paint(s) {
  if (!s) return;
  $("status").textContent = s.status || "Ready";
  $("completed").textContent = String(s.completed || 0);
  $("dot").className = s.paused ? "warning" : s.running ? "active" : "";
}
async function refresh() {
  $("error").textContent = "";
  const tab = await pavoTab();
  if (!tab?.id) {
    $("status").textContent = "Pavo tab not active";
    $("hint").textContent = "Open app.pavo-ai.work, then reopen this popup.";
    $("buttons").textContent = "—";
    return;
  }
  try {
    const scan = await chrome.tabs.sendMessage(tab.id,{type:"PAVO_SCAN"});
    $("buttons").textContent = String(scan.generateButtons);
    $("hint").textContent = scan.generating ? "A video is generating; another will not be started." : "Ready to scan the scene list.";
  } catch {
    $("status").textContent = "Refresh Pavo tab";
    $("hint").textContent = "Reload the Pavo page after installing the extension.";
  }
  const saved = await chrome.storage.local.get("pavoQueueState");
  paint(saved.pavoQueueState);
}
async function run(type) {
  $("error").textContent = "";
  try {
    const tab = await pavoTab();
    if (!tab?.id) throw new Error("Open the Pavo episode page in the active tab.");
    const result = await chrome.tabs.sendMessage(tab.id,{type});
    if (result?.ok === false) throw new Error(result.error || "Action failed.");
    await refresh();
  } catch (e) {$("error").textContent = e.message || "Could not contact Pavo. Refresh the tab.";}
}
$("start").addEventListener("click",()=>run("PAVO_START"));
$("pause").addEventListener("click",()=>run("PAVO_PAUSE"));
$("resume").addEventListener("click",()=>run("PAVO_RESUME"));
$("stop").addEventListener("click",()=>run("PAVO_STOP"));
refresh();