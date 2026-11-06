(() => {
  "use strict";
  if (window.__pavoQueueController) return;

  const c = window.__pavoQueueController = {
    running: false, paused: false, busy: false, observer: null,
    startedAt: 0, stableChecks: 0, maxMs: 12 * 60 * 1000
  };
  const KEY = "pavoQueueState";
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();

  async function state() {
    const d = await chrome.storage.local.get(KEY);
    return d[KEY] || {completed: 0, status: "Ready"};
  }
  async function save(patch) {
    const old = await state();
    await chrome.storage.local.set({[KEY]: {...old, ...patch, updatedAt: Date.now()}});
  }
  function visible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" &&
      s.visibility !== "hidden" && Number(s.opacity) !== 0;
  }
  function label(el) {
    return norm(el.innerText || el.getAttribute("aria-label") || el.title);
  }
  function buttons() {
    return [...document.querySelectorAll("button,[role='button']")].filter(visible);
  }
  function generating() {
    const explicitText = [...document.querySelectorAll("body *")].some(el => {
      if (!visible(el) || el.children.length > 3) return false;
      const t = norm(el.innerText || el.textContent);
      return /^(generating(?:\\.\\.\\.)?|processing(?:\\.\\.\\.)?|creating video(?:\\.\\.\\.)?|rendering(?:\\.\\.\\.)?)$/.test(t);
    });
    const stop = buttons().some(b => /^(stop|cancel)$/.test(label(b)));
    return explicitText || stop;
  }
  function sceneGenerateButtons() {
    return buttons().filter(b =>
      /^generate$/.test(label(b)) &&
      !b.disabled &&
      b.getAttribute("aria-disabled") !== "true"
    );
  }

  function videoMenuButtons() {
    // Pavo's popup may render the option as a div/button wrapper rather than
    // a native <button>. Search all visible elements and select the smallest
    // element whose visible text starts with "Generate Video".
    const all = [...document.querySelectorAll("body *")]
      .filter(visible)
      .filter(el => {
        const text = label(el);
        return /^generate video(?:\\s|✦|$)/i.test(text) &&
          text.length <= 80 &&
          !/^generate video.*generate image/i.test(text);
      });

    // Prefer native buttons / role=button when available.
    const preferred = all.filter(el =>
      el.matches("button,[role='button']") &&
      !el.disabled &&
      el.getAttribute("aria-disabled") !== "true"
    );
    if (preferred.length) return preferred;

    // Otherwise choose the smallest matching visible element. This handles
    // Pavo's popup components when the clickable surface is a div.
    return all
      .filter(el => {
        const parent = el.parentElement;
        if (!parent) return true;
        const parentText = label(parent);
        return !/^generate video(?:\\s|✦|$)/i.test(parentText) ||
          parentText.length > 80;
      })
      .filter(el => el.getAttribute("aria-disabled") !== "true");
  }
  function cleanup() {
    c.observer?.disconnect();
    c.observer = null;
  }
  async function pause(message) {
    c.running = false; c.paused = true; c.busy = false; cleanup();
    await save({running: false, paused: true, status: message || "Paused"});
  }
  async function waitUntilFinished(button) {
    c.startedAt = Date.now(); c.stableChecks = 0;
    await save({status: "Generating — waiting for Pavo"});
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!c.running || c.paused) return resolve(false);
        if (Date.now() - c.startedAt > c.maxMs) return reject(new Error("Generation timeout; queue paused."));
        const active = generating() || (button.isConnected && /generating|stop/.test(label(button)));
        if (active) c.stableChecks = 0;
        else c.stableChecks++;
        if (c.stableChecks >= 6) resolve(true);
      };
      c.observer = new MutationObserver(check);
      c.observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true});
      const timer = setInterval(() => {
        if (!c.running || c.paused || c.stableChecks >= 6 || Date.now() - c.startedAt > c.maxMs) {
          clearInterval(timer); cleanup();
        }
        check();
      }, 1500);
      check();
    });
  }
  async function processOne() {
    if (!c.running || c.paused || c.busy) return;
    c.busy = true;
    try {
      if (generating()) {
        await pause("A generation is already active. Wait, then press Resume.");
        return;
      }
      await sleep(700);
      if (!c.running) return;
      const sceneButton = sceneGenerateButtons()[0];
      if (!sceneButton) {
        await pause("No scene Generate button found. Check the page and press Resume.");
        return;
      }

      sceneButton.scrollIntoView({behavior: "instant", block: "center", inline: "nearest"});
      await sleep(250);

      if (generating()) {
        await pause("Generation detected before click; paused to prevent overlap.");
        return;
      }

      // Pavo requires two clicks:
      // 1) scene Generate -> opens menu
      // 2) Generate Video -> starts the actual video job
      sceneButton.click();
      await save({status: "Generation menu opened — selecting Generate Video"});

      let videoButton = null;
      for (let i = 0; i < 30 && c.running; i++) {
        videoButton = videoMenuButtons()[0];
        if (videoButton) break;
        await sleep(200);
      }

      if (!videoButton) {
        await pause("Generate menu opened, but Generate Video was not found. Check Pavo and press Resume.");
        return;
      }

      videoButton.scrollIntoView({behavior: "instant", block: "center", inline: "nearest"});
      await sleep(200);

      if (generating()) {
        await pause("A generation appeared before Generate Video was clicked.");
        return;
      }

      // Use a real pointer-style click first. Some Pavo UI components
      // listen for pointer/click events on a wrapper instead of a native button.
      videoButton.dispatchEvent(new PointerEvent("pointerdown", {bubbles:true, cancelable:true, view:window}));
      videoButton.dispatchEvent(new PointerEvent("pointerup", {bubbles:true, cancelable:true, view:window}));
      videoButton.click();

      let started = false;
      for (let i = 0; i < 30 && c.running; i++) {
        await sleep(500);
        if (generating() || !videoButton.isConnected || videoButton.disabled || /generating|stop/.test(label(videoButton))) {
          started = true; break;
        }
      }

      if (!started) {
        await pause("Could not confirm that Pavo started video generation. Check Pavo before resuming.");
        return;
      }

      const done = await waitUntilFinished(videoButton);
      cleanup();
      if (!done) return;
      const s = await state();
      await save({completed: (s.completed || 0) + 1, status: "Video completed"});
      c.busy = false;
      await sleep(900);
      if (c.running && !c.paused) await processOne();
    } catch (e) {
      cleanup();
      await pause(e.message || "Pavo state unclear; queue paused.");
    } finally {
      c.busy = false;
    }
  }
  async function start() {
    if (c.running) return {ok: true};
    if (generating()) return {ok: false, error: "Pavo is already generating. Let it finish before starting."};
    c.running = true; c.paused = false;
    await save({running: true, paused: false, status: "Scanning for Generate"});
    processOne();
    return {ok: true};
  }
  async function resume() {
    if (generating()) return {ok: false, error: "A generation is still active. Resume after it finishes."};
    return start();
  }
  async function stop() {
    c.running = false; c.paused = false; c.busy = false; cleanup();
    await save({running: false, paused: false, status: "Stopped"});
    return {ok: true};
  }
  chrome.runtime.onMessage.addListener((m, sender, respond) => {
    if (m?.type === "PAVO_START") { start().then(respond); return true; }
    if (m?.type === "PAVO_RESUME") { resume().then(respond); return true; }
    if (m?.type === "PAVO_PAUSE") { pause("Paused by user").then(() => respond({ok:true})); return true; }
    if (m?.type === "PAVO_STOP") { stop().then(respond); return true; }
    if (m?.type === "PAVO_SCAN") {
      respond({ok:true, generating: generating(), generateButtons: sceneGenerateButtons().length,
        videoMenuButtons: videoMenuButtons().length});
      return true;
    }
  });
  state().then(s => {
    if (s.running) save({running:false, paused:true, status:"Page refreshed — verify Pavo, then Resume"});
  });
})();