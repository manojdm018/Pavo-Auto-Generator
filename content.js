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

  function allVisibleElementsDeep(root = document) {
    const out = [];
    const visit = node => {
      const children = node instanceof Document || node instanceof ShadowRoot
        ? [...node.children]
        : [...(node.children || [])];
      for (const el of children) {
        out.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
        visit(el);
      }
    };
    visit(root);
    return out;
  }

  function videoMenuButtons() {
    const all = allVisibleElementsDeep()
      .filter(visible)
      .filter(el => {
        const text = label(el);
        return /^generate video(?:\\s|✦|$)/i.test(text) && text.length <= 80;
      });

    // Prefer the most directly clickable element. Pavo may use a native
    // button, role=button, or a styled div inside a dialog.
    const preferred = all.filter(el =>
      el.matches("button,[role='button'],a") &&
      !el.disabled &&
      el.getAttribute("aria-disabled") !== "true"
    );
    if (preferred.length) return preferred;

    // If the text is inside a styled wrapper, return the smallest matching
    // element rather than the outer dialog/container.
    return all.filter(el => {
      const parent = el.parentElement;
      if (!parent) return true;
      const parentText = label(parent);
      return !/^generate video(?:\\s|✦|$)/i.test(parentText) || parentText.length > 80;
    });
  }

  function findClickableAncestor(el) {
    let current = el;
    for (let i = 0; current && i < 6; i++, current = current.parentElement) {
      if (
        current.matches?.("button,[role='button'],a") ||
        getComputedStyle(current).cursor === "pointer"
      ) return current;
    }
    return el;
  }

  function forceClick(el) {
    const target = findClickableAncestor(el);
    target.scrollIntoView({behavior: "instant", block: "center", inline: "center"});
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    // First use the native click.
    if (typeof target.click === "function") target.click();

    // Then dispatch real mouse/pointer-style events for UI libraries that
    // listen to pointer events on the clickable surface.
    for (const type of ["pointerover", "pointermove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const EventClass = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      target.dispatchEvent(new EventClass(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0
      }));
    }

    // Finally click the element actually sitting under the center point.
    const under = document.elementFromPoint(x, y);
    if (under && under !== target && target.contains(under)) {
      if (typeof under.click === "function") under.click();
    }
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
      forceClick(videoButton);

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
      const videoCandidates = videoMenuButtons();
      respond({
        ok: true,
        generating: generating(),
        generateButtons: sceneGenerateButtons().length,
        videoMenuButtons: videoCandidates.length,
        videoCandidateTexts: videoCandidates.slice(0, 5).map(label)
      });
      return true;
    }
  });
  state().then(s => {
    if (s.running) save({running:false, paused:true, status:"Page refreshed — verify Pavo, then Resume"});
  });
})();