(() => {
  "use strict";
  if (window.__pavoQueueController) return;

  const c = window.__pavoQueueController = {
    running: false, paused: false, busy: false, observer: null,
    startedAt: 0, stableChecks: 0, maxMs: 12 * 60 * 1000
  };
  const KEY = "pavoQueueState";
  const sceneKey = i => "pavoScene_" + i;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

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

  function menuButtons() {
    return allVisibleElementsDeep()
      .filter(el => visible(el))
      .filter(el => {
        if (!el.matches?.("button")) return false;
        if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;

        const text = norm(el.innerText || el.textContent);
        if (!/^(generate image|generate video)\b/i.test(text)) return false;

        const star = el.querySelector('img[src*="generate-star-white.svg"]');
        return !!star;
      });
  }

  function imageMenuButtons() {
    return menuButtons().filter(b => /^generate image\b/i.test(norm(b.innerText || b.textContent)));
  }

  function videoMenuButtons() {
    return menuButtons().filter(b => /^generate video\b/i.test(norm(b.innerText || b.textContent)));
  }


  function scrollableParents(el) {
    const out = [];
    let p = el?.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      const s = getComputedStyle(p);
      const canScrollY = /(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 20;
      const canScrollX = /(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 20;
      if (canScrollY || canScrollX) out.push(p);
      p = p.parentElement;
    }
    return out;
  }

  async function bringIntoView(el, attempts = 3) {
    if (!el) return false;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        el.scrollIntoView({behavior: "instant", block: "center", inline: "nearest"});
      } catch (_) {}

      // Pavo can place the scene list inside a nested scroll container.
      // Move every scrollable ancestor so the button is actually visible,
      // rather than relying only on the page viewport.
      const parents = scrollableParents(el);
      const rect = el.getBoundingClientRect();

      for (const p of parents) {
        const pr = p.getBoundingClientRect();
        const targetTop = p.scrollTop + (rect.top - pr.top) - (p.clientHeight - rect.height) / 2;
        p.scrollTop = Math.max(0, Math.min(targetTop, p.scrollHeight - p.clientHeight));
      }

      window.scrollTo({
        top: Math.max(0, window.scrollY + el.getBoundingClientRect().top - (window.innerHeight - el.getBoundingClientRect().height) / 2),
        behavior: "instant"
      });

      await sleep(250);

      const r = el.getBoundingClientRect();
      const inViewport = r.bottom > 20 && r.top < window.innerHeight - 20;
      if (inViewport) return true;
    }
    return false;
  }

  async function findSceneButton(index, timeoutMs = 6000) {
    const started = Date.now();

    while (c.running && Date.now() - started < timeoutMs) {
      let list = sceneGenerateButtons();
      if (list[index]) {
        await bringIntoView(list[index], 2);
        // Re-query after scrolling because React/Pavo may re-render the list.
        list = sceneGenerateButtons();
        if (list[index]) return list[index];
      }

      // If the scene list is virtualized, the target button may not exist in
      // the DOM yet. Advance the likely scroll container and keep scanning.
      const candidates = [...document.querySelectorAll("*")].filter(el => {
        if (!(el instanceof HTMLElement) || !visible(el)) return false;
        return el.scrollHeight > el.clientHeight + 200 &&
          /(auto|scroll)/.test(getComputedStyle(el).overflowY);
      });

      const target = candidates.sort((a, b) =>
        (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
      )[0];

      if (target) {
        const step = Math.max(300, Math.floor(target.clientHeight * 0.75));
        target.scrollTop = Math.min(target.scrollTop + step, target.scrollHeight - target.clientHeight);
      } else {
        window.scrollBy({top: Math.max(400, Math.floor(window.innerHeight * 0.7)), behavior: "instant"});
      }

      await sleep(350);
    }

    return null;
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
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    // Use ONE click only. Pavo's Generate button toggles the menu.
    // Sending native click + synthetic click events can open it and immediately
    // close it again, which is especially bad when reopening the menu for Video.
    if (typeof target.click === "function") {
      target.click();
    } else {
      target.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0
      }));
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
  async function waitForMenuButton(kind, timeoutMs = 8000) {
    const started = Date.now();
    while (c.running && Date.now() - started < timeoutMs) {
      const found = kind === "image" ? imageMenuButtons()[0] : videoMenuButtons()[0];
      if (found) return found;
      await sleep(200);
    }
    return null;
  }

  async function clickAndWaitForGeneration(button, type) {
    button.scrollIntoView({behavior: "instant", block: "center", inline: "center"});
    await sleep(200);

    if (generating()) {
      await pause("Generation detected before Generate " + type + " was clicked.");
      return false;
    }

    forceClick(button);

    // Give Pavo time to change the button/UI into its generating state.
    for (let i = 0; i < 30 && c.running; i++) {
      await sleep(400);
      if (generating() || !button.isConnected || button.disabled ||
          /generating|processing|creating|rendering|stop/.test(label(button))) {
        const done = await waitUntilFinished(button);
        return done;
      }
    }

    await pause("Could not confirm that Generate " + type + " started. Check Pavo before resuming.");
    return false;
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

      // Use the completed-scene count to select the next unprocessed scene.
      // Never fall back to [0], otherwise Pavo can regenerate Scene 1 forever.
      const stBefore = await state();
      const sceneIndex = Number(stBefore.completed || 0);
      const sceneButtons = sceneGenerateButtons();

      // The completed count is our durable checkpoint. Also persist the
      // current scene index so a page refresh can resume from the same scene.
      await chrome.storage.local.set({
        [sceneKey(sceneIndex)]: {status: "in-progress", updatedAt: Date.now()}
      });

      const sceneButton = sceneButtons[sceneIndex];
      if (!sceneButton) {
        await pause("No scene Generate button found. Check the page and press Resume.");
        return;
      }

      const positionedSceneButton = await findSceneButton(sceneIndex);
      if (!positionedSceneButton) {
        await pause("Could not locate Scene " + (sceneIndex + 1) + " on screen. Check the scene list and press Resume.");
        return;
      }
      await bringIntoView(positionedSceneButton, 3);
      await sleep(300);

      if (generating()) {
        await pause("Generation detected before the scene Generate button was clicked.");
        return;
      }

      // Each Pavo scene is a two-stage generation:
      // Scene Generate -> Generate Image -> wait -> Generate Video -> wait.
      forceClick(positionedSceneButton);
      await save({status: "Scene menu opened — selecting Generate Image"});

      const imageButton = await waitForMenuButton("image");
      if (!imageButton) {
        await pause("Generate Image was not found in the menu. Check Pavo and press Resume.");
        return;
      }

      const imageDone = await clickAndWaitForGeneration(imageButton, "Image");
      cleanup();
      if (!imageDone) return;

      await save({status: "Reference image completed — opening menu for Generate Video"});
      await sleep(1000);

      // Pavo closes the generation menu after the image is created.
      // Re-open this SAME scene's Generate menu before looking for Video.
      const currentButtons = sceneGenerateButtons();
      const videoSceneButton = currentButtons[sceneIndex];
      if (!videoSceneButton) {
        await pause("The current scene Generate button was not found after the image. Check Pavo and press Resume.");
        return;
      }

      await bringIntoView(videoSceneButton, 3);
      await sleep(300);
      forceClick(videoSceneButton);
      await sleep(500);

      const videoButton = await waitForMenuButton("video");
      if (!videoButton) {
        await pause("Generate Video was not found in the reopened scene menu. Check Pavo and press Resume.");
        return;
      }

      const videoDone = await clickAndWaitForGeneration(videoButton, "Video");
      cleanup();
      if (!videoDone) return;

      const st = await state();
      const nextCompleted = (st.completed || 0) + 1;
      const nextDelay = 5;
      await chrome.storage.local.set({
        [sceneKey(sceneIndex)]: {status: "completed", completedAt: Date.now()}
      });
      await save({
        completed: nextCompleted,
        currentScene: nextCompleted,
        status: "Completed — scrolling to next scene",
        nextAt: Date.now() + nextDelay * 1000,
        nextDelay
      });

      c.busy = false;

      // Move the next scene into view before starting it.
      // Re-scan after completion because Pavo may re-render the scene list.
      await sleep(400);
      const nextButton = await findSceneButton(nextCompleted, 7000);
      if (nextButton) {
        await bringIntoView(nextButton, 3);
        await sleep(500);
      } else {
        await pause("Completed Scene " + sceneIndex + ", but Scene " + (nextCompleted + 1) + " could not be located. Check the scene list and press Resume.");
        return;
      }

      for (let remaining = nextDelay; remaining > 0 && c.running && !c.paused; remaining--) {
        await save({
          status: "Next scene in " + remaining + "s",
          nextAt: Date.now() + remaining * 1000,
          nextDelay: remaining
        });
        await sleep(1000);
      }

      await save({nextAt: 0, nextDelay: 0, status: "Starting next scene"});
      if (c.running && !c.paused) {
        await processOne();
      }
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
    await save({running: true, paused: false, status: "Resuming from scene " + ((await state()).completed || 0) + " — scanning"});
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