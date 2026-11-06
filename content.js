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
  function generationStatus() {
    // Do not search the whole page for words such as "creating" or
    // "generating": those can appear in prompts, help text, or unrelated UI.
    // Pavo's scene preview is the specific aspect-ratio container present
    // in the DOM the user shared.
    const previewCards = [...document.querySelectorAll('[class*="aspect-[533/300]"]')]
      .filter(visible);
    const activeLabel = /^(generating(?:[.]{1,3})?|processing(?:[.]{1,3})?|creating (?:image|video)(?:[.]{1,3})?|rendering(?:[.]{1,3})?|uploading(?:[.]{1,3})?|queued(?:[.]{1,3})?)$/i;
    const evidence = [];

    for (const card of previewCards) {
      if (card.getAttribute("aria-busy") === "true") {
        evidence.push("Scene preview is aria-busy");
      }

      const statusNodes = [...card.querySelectorAll("p,span,[role='status'],[aria-live]")]
        .filter(visible);
      for (const node of statusNodes) {
        if (node.children.length > 1) continue;
        const t = norm(node.innerText || node.textContent);
        if (activeLabel.test(t)) evidence.push("Scene preview status: " + t);
      }

      const action = [...card.querySelectorAll("button,[role='button']")]
        .find(b => visible(b) && /^(stop|cancel)$/.test(label(b)));
      if (action) evidence.push("Scene preview has " + label(action) + " action");
    }

    // Some app versions expose generation state through an accessible live
    // status outside the preview. Accept only an exact status label, never a
    // substring from arbitrary page copy or prompts.
    const accessibleStatuses = [...document.querySelectorAll("[role='status'],[aria-live]")]
      .filter(visible);
    for (const node of accessibleStatuses) {
      const t = norm(node.innerText || node.textContent);
      if (activeLabel.test(t)) evidence.push("Accessible status: " + t);
    }

    return {
      active: evidence.length > 0,
      reason: evidence[0] || "No active generation indicator found",
      evidence,
      previewCards: previewCards.length
    };
  }

  function generating() {
    return generationStatus().active;
  }

  function sceneGenerateButtons() {
    return buttons().filter(b =>
      /^generate$/.test(label(b)) &&
      !b.disabled &&
      b.getAttribute("aria-disabled") !== "true"
    );
  }

  // Pavo renders each scene as a self-contained card. The card supplied by
  // the user has the distinctive aspect-[533/300] class and contains both
  // the scene state text and its Generate button. Use that relationship
  // instead of assuming that the Nth global Generate button is Scene N.
  function sceneCards() {
    const cards = [];
    const seen = new Set();

    for (const button of sceneGenerateButtons()) {
      let p = button.parentElement;
      let card = null;

      for (let depth = 0; p && depth < 8; depth++, p = p.parentElement) {
        const cls = typeof p.className === "string" ? p.className : "";
        const hasAspect = cls.includes("aspect-[533/300]");
        const hasGenerate = [...p.querySelectorAll("button")].some(
          b => /^generate$/.test(label(b))
        );

        if (hasAspect && hasGenerate) {
          card = p;
          break;
        }
      }

      // Fallback: use the nearest ancestor that owns exactly one Generate
      // button and has meaningful scene content.
      if (!card) {
        p = button.parentElement;
        for (let depth = 0; p && depth < 8; depth++, p = p.parentElement) {
          const owned = [...p.querySelectorAll("button")].filter(
            b => /^generate$/.test(label(b))
          );
          const text = norm(p.innerText || p.textContent);
          if (owned.length === 1 && text.length > 10) {
            card = p;
            break;
          }
        }
      }

      if (card && !seen.has(card)) {
        seen.add(card);
        cards.push(card);
      }
    }

    return cards;
  }

  function generateButtonInCard(card) {
    if (!card) return null;
    return [...card.querySelectorAll("button")].find(b =>
      visible(b) &&
      /^generate$/.test(label(b)) &&
      !b.disabled &&
      b.getAttribute("aria-disabled") !== "true"
    ) || null;
  }

  function sceneCardInfo() {
    return sceneCards().map((card, index) => ({
      index,
      text: norm(card.innerText || card.textContent).slice(0, 180),
      button: !!generateButtonInCard(card)
    }));
  }

  function cardSnapshot(card) {
    if (!card || !card.isConnected) return "";
    const text = norm(card.innerText || card.textContent);
    const media = [...card.querySelectorAll("img,video,canvas")]
      .map(el => {
        if (el.tagName === "IMG") {
          const src = el.currentSrc || el.src || "";
          if (src.includes("/images/playlet/") || src.includes("generate-star")) return null;
          return "img:" + src;
        }
        return el.tagName.toLowerCase();
      })
      .filter(Boolean);
    const states = [...card.querySelectorAll("[aria-label],[data-state],[role='progressbar']")]
      .map(el => [
        el.getAttribute("aria-label") || "",
        el.getAttribute("data-state") || "",
        el.getAttribute("role") || ""
      ].join(":"));
    return JSON.stringify({text, media, states});
  }

  function cardIsActive(card) {
    if (!card || !card.isConnected) return false;
    const text = norm(card.innerText || card.textContent);
    if (/\b(generating|processing|rendering|creating|uploading|queued)\b/.test(text)) return true;
    return [...card.querySelectorAll("button,[role='button']")]
      .some(b => /^(stop|cancel)$/.test(label(b)));
  }

  function cardHasOutput(card, kind, beforeSnapshot) {
    if (!card || !card.isConnected || cardSnapshot(card) === beforeSnapshot) return false;

    const text = norm(card.innerText || card.textContent);
    const realImages = [...card.querySelectorAll("img")].filter(img => {
      const src = img.currentSrc || img.src || "";
      return !!src && !src.includes("/images/playlet/") &&
        !src.includes("generate-star") && !src.startsWith("data:image/svg");
    });

    if (kind === "Image") {
      return realImages.length > 0 ||
        /image (ready|generated|complete)|reference image/.test(text) ||
        (!text.includes("waiting to generate") && !/\b(generating|processing|rendering|creating|uploading)\b/.test(text));
    }

    return card.querySelector("video") !== null ||
      /video (ready|generated|complete)|play video/.test(text);
  }

  function cardForSceneButton(button, index) {
    const cards = sceneCards();
    return cards.find(card => card.contains(button)) || cards[index] || null;
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


  function visibleMenuActionLabels() {
    return buttons()
      .map(b => norm(b.innerText || b.textContent))
      .filter(t => /^(generate image|generate video)\b/.test(t));
  }

  function exactVideoMenuButton() {
    return menuButtons().find(b => {
      const text = norm(b.innerText || b.textContent);
      const hasWhiteStar = !!b.querySelector('img[src*="generate-star-white.svg"]');
      return /^generate video(?:\s|$)/.test(text) && hasWhiteStar;
    }) || null;
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

  async function findSceneButton(index, timeoutMs = 10000) {
    const started = Date.now();

    while (c.running && Date.now() - started < timeoutMs) {
      const cards = sceneCards();
      const card = cards[index];

      if (card) {
        const button = generateButtonInCard(card);
        if (button) {
          await bringIntoView(card, 3);
          await sleep(250);

          // React can replace the card while scrolling. Re-find the card
          // after it settles, then return its current Generate button.
          const refreshed = sceneCards()[index];
          const refreshedButton = generateButtonInCard(refreshed || card);
          if (refreshedButton) return refreshedButton;
        }
      }

      // If the requested card is virtualized, progressively scroll the
      // largest scroll container until more scene cards are mounted.
      const candidates = [...document.querySelectorAll("*")].filter(el => {
        if (!(el instanceof HTMLElement) || !visible(el)) return false;
        return el.scrollHeight > el.clientHeight + 200 &&
          /(auto|scroll)/.test(getComputedStyle(el).overflowY);
      });

      const target = candidates.sort((a, b) =>
        (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
      )[0];

      if (target) {
        const step = Math.max(350, Math.floor(target.clientHeight * 0.65));
        const before = target.scrollTop;
        target.scrollTop = Math.min(
          target.scrollTop + step,
          target.scrollHeight - target.clientHeight
        );

        // If it cannot scroll farther, try the page itself.
        if (target.scrollTop === before) {
          window.scrollBy({
            top: Math.max(350, Math.floor(window.innerHeight * 0.65)),
            behavior: "instant"
          });
        }
      } else {
        window.scrollBy({
          top: Math.max(350, Math.floor(window.innerHeight * 0.65)),
          behavior: "instant"
        });
      }

      await sleep(450);
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

  async function clickAndWaitForGeneration(button, type, getCard) {
    if (!button || !button.isConnected) {
      await pause("Generate " + type + " action disappeared before it could be clicked.");
      return false;
    }

    button.scrollIntoView({behavior: "instant", block: "center", inline: "center"});
    await sleep(200);

    if (generating()) {
      await pause("Generation detected before Generate " + type + " was clicked.");
      return false;
    }

    const initialCard = typeof getCard === "function" ? getCard() : null;
    const beforeSnapshot = cardSnapshot(initialCard);
    forceClick(button);
    await save({status: "Generate " + type + " selected — verifying Pavo started"});

    const startedAt = Date.now();
    let observedActive = false;
    let lastSnapshot = beforeSnapshot;
    let stableAfterChange = 0;

    while (c.running && Date.now() - startedAt < c.maxMs) {
      const card = (typeof getCard === "function" ? getCard() : null) ||
        (initialCard && initialCard.isConnected ? initialCard : null);
      const snapshot = cardSnapshot(card);
      const active = generating() || cardIsActive(card);
      const changed = !!snapshot && snapshot !== beforeSnapshot;
      const hasOutput = cardHasOutput(card, type, beforeSnapshot);

      if (active) {
        observedActive = true;
        stableAfterChange = 0;
      } else if (changed && hasOutput) {
        if (snapshot === lastSnapshot) stableAfterChange++;
        else stableAfterChange = 1;
      } else if (observedActive && changed) {
        if (snapshot === lastSnapshot) stableAfterChange++;
        else stableAfterChange = 1;
      } else {
        stableAfterChange = 0;
      }

      // The menu's Generate Image/Video button is removed when the menu
      // closes. That is normal and is deliberately NOT treated as completion.
      // Require either a witnessed active state followed by a changed,
      // stable scene, or a completed output appearing without an activity
      // indicator (for very fast generations).
      if (changed && !active && hasOutput && stableAfterChange >= 4) {
        return true;
      }
      if (observedActive && changed && !active && stableAfterChange >= 4) {
        return true;
      }

      lastSnapshot = snapshot;
      await sleep(1200);
    }

    await pause("Could not verify that Generate " + type + " finished. Queue paused to avoid starting the next stage too early.");
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

      await sleep(500);
      if (!c.running) return;

      const stBefore = await state();
      const sceneIndex = Number(stBefore.completed || 0);
      const key = sceneKey(sceneIndex);
      const stored = await chrome.storage.local.get(key);
      const sceneProgress = stored[key] || {};

      // A prior video click may have happened just before a refresh or a
      // timeout. Do not blindly click Video a second time; ask for a manual
      // state check unless the video stage was conclusively completed.
      if (sceneProgress.stage === "video-in-progress") {
        await pause(
          "Scene " + (sceneIndex + 1) + " already has a Video attempt recorded. Check Pavo's scene preview; I will not generate Image or Video again automatically."
        );
        return;
      }

      const imageAlreadyComplete = sceneProgress.stage === "image-complete";

      await save({
        currentScene: sceneIndex,
        status: imageAlreadyComplete
          ? "Scene " + (sceneIndex + 1) + ": image already complete — preparing Video"
          : "Locating Scene " + (sceneIndex + 1)
      });

      const sceneButton = await findSceneButton(sceneIndex, 12000);
      if (!sceneButton) {
        await pause("Could not locate Scene " + (sceneIndex + 1) + ". Check the scene list and press Resume.");
        return;
      }

      await bringIntoView(sceneButton, 3);
      await sleep(250);

      const originalSceneCard = cardForSceneButton(sceneButton, sceneIndex);
      const getCurrentSceneCard = () => {
        const cards = sceneCards();
        return cards[sceneIndex] ||
          (originalSceneCard && originalSceneCard.isConnected ? originalSceneCard : null);
      };

      // Stage 1: Generate Image. This block is skipped permanently once the
      // image-complete checkpoint has been saved, including after a refresh
      // or Resume. The Image action is never selected in the Video stage.
      if (!imageAlreadyComplete) {
        if (generating()) {
          await pause("A generation became active before Generate Image. Check Pavo.");
          return;
        }

        await chrome.storage.local.set({
          [key]: {
            ...sceneProgress,
            status: "image-in-progress",
            stage: "image-in-progress",
            updatedAt: Date.now()
          }
        });

        forceClick(sceneButton);
        await save({status: "Scene " + (sceneIndex + 1) + ": opening Image/Video menu"});

        const imageButton = await waitForMenuButton("image", 10000);
        if (!imageButton) {
          await pause("Generate Image was not found. No action was selected.");
          return;
        }

        const imageDone = await clickAndWaitForGeneration(
          imageButton,
          "Image",
          getCurrentSceneCard
        );
        cleanup();
        if (!imageDone) return;

        // Save this immediately, before attempting to open or select Video.
        await chrome.storage.local.set({
          [key]: {
            status: "image-complete",
            stage: "image-complete",
            imageCompletedAt: Date.now()
          }
        });
        await save({status: "Scene " + (sceneIndex + 1) + ": image complete — selecting Video"});
      } else {
        await save({status: "Scene " + (sceneIndex + 1) + ": skipping Image (already complete)"});
      }

      // Stage 2: Generate Video. First inspect the current menu. If the
      // menu is closed, open it ONCE. If Image is visible but Video is not,
      // stop safely; never click Image and never toggle an already-open menu.
      let videoButton = exactVideoMenuButton();

      if (!videoButton) {
        const visibleActions = visibleMenuActionLabels();

        if (visibleActions.some(t => /^generate image(?:\s|$)/.test(t))) {
          await pause(
            "Image is already complete, but Pavo's open menu does not expose a detectable Generate Video action. Visible actions: " +
            visibleActions.join(" | ") +
            ". I did not select Image again."
          );
          return;
        }

        const currentSceneButton = await findSceneButton(sceneIndex, 10000);
        if (!currentSceneButton) {
          await pause("Image is complete, but the current scene's Generate button could not be located to open the Video menu.");
          return;
        }

        await bringIntoView(currentSceneButton, 3);
        await sleep(250);

        // Re-check after scrolling, before toggling the menu.
        videoButton = exactVideoMenuButton();
        const actionsAfterScroll = visibleMenuActionLabels();

        if (!videoButton && actionsAfterScroll.some(t => /^generate image(?:\s|$)/.test(t))) {
          await pause(
            "Image is complete, but Generate Video is not detectable in the open menu. Visible actions: " +
            actionsAfterScroll.join(" | ") +
            ". I did not select Image again."
          );
          return;
        }

        if (!videoButton && actionsAfterScroll.length === 0) {
          forceClick(currentSceneButton);
          await sleep(300);
          videoButton = await waitForMenuButton("video", 10000);
        }
      }

      // A final strict guard: absolutely no button other than the exact
      // Generate Video action may be clicked in this stage.
      if (!videoButton) {
        const actions = visibleMenuActionLabels();
        await pause(
          "Image is complete, but Generate Video could not be identified. Visible menu actions: " +
          (actions.join(" | ") || "none") +
          ". The Image action was not clicked again."
        );
        return;
      }

      const videoText = norm(videoButton.innerText || videoButton.textContent);
      if (!/^generate video(?:\s|$)/.test(videoText)) {
        await pause("Safety check blocked an unexpected menu action: " + videoText);
        return;
      }

      await chrome.storage.local.set({
        [key]: {
          status: "video-in-progress",
          stage: "video-in-progress",
          imageCompletedAt: sceneProgress.imageCompletedAt || Date.now(),
          videoStartedAt: Date.now()
        }
      });

      const videoDone = await clickAndWaitForGeneration(
        videoButton,
        "Video",
        getCurrentSceneCard
      );
      cleanup();
      if (!videoDone) return;

      const currentState = await state();
      const nextCompleted = (currentState.completed || 0) + 1;
      const nextDelay = 5;

      await chrome.storage.local.set({
        [key]: {
          status: "completed",
          stage: "completed",
          completedAt: Date.now()
        }
      });

      await save({
        completed: nextCompleted,
        currentScene: nextCompleted,
        status: "Scene " + (sceneIndex + 1) + " video complete — moving to next scene",
        nextAt: Date.now() + nextDelay * 1000,
        nextDelay
      });

      c.busy = false;

      await sleep(400);
      const nextButton = await findSceneButton(nextCompleted, 10000);
      if (!nextButton) {
        // End cleanly when no next scene card exists. Do not repeatedly
        // scroll forever or restart Scene 1.
        await save({
          running: false,
          paused: false,
          status: "Queue completed — no further scene found",
          nextAt: 0,
          nextDelay: 0
        });
        c.running = false;
        return;
      }

      await bringIntoView(nextButton, 3);
      await sleep(400);

      for (let remaining = nextDelay; remaining > 0 && c.running && !c.paused; remaining--) {
        await save({
          status: "Next scene in " + remaining + "s",
          nextAt: Date.now() + remaining * 1000,
          nextDelay: remaining
        });
        await sleep(1000);
      }

      await save({nextAt: 0, nextDelay: 0, status: "Starting next scene"});
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
    const detection = generationStatus();
    if (detection.active) {
      return {
        ok: false,
        error: "Pavo generation detected: " + detection.reason + ". Check the scene preview before starting."
      };
    }
    c.running = true; c.paused = false;
    await save({running: true, paused: false, status: "Resuming from scene " + ((await state()).completed || 0) + " — scanning"});
    processOne();
    return {ok: true};
  }
  async function resume() {
    const detection = generationStatus();
    if (detection.active) {
      return {
        ok: false,
        error: "Pavo generation detected: " + detection.reason + ". Resume after the scene preview is idle."
      };
    }
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
      const generation = generationStatus();
      respond({
        ok: true,
        generating: generation.active,
        generation,
        generateButtons: sceneGenerateButtons().length,
        sceneCards: sceneCardInfo(),
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