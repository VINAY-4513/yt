/**
 * YouTube preview-scene assessment.
 * Factual claims and publisher identity are not verified without external sources.
 */
(function () {
  "use strict";

  let baseSession = null;
  const verdictCache = new Map();
  let currentCard = null;
  let hoverTimer = null;
  let activeAbortController = null;
  let isPromptExecuting = false;

  const CARD_SELECTORS = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-movie-renderer",
    "yt-lockup-view-model",
    "ytd-reel-item-renderer",
    "ytd-rich-grid-slim-media",
    "ytm-shorts-lockup-view-model"
  ].join(", ");

  const SYSTEM_PROMPT =
    "Assess only whether the supplied preview frame visibly matches the video title. " +
    "A single preview frame cannot establish the truth of factual claims, the identity of a publisher, " +
    "whether a whole video is authentic, or whether a video is deceptive. Never infer those conclusions. " +
    "If the frame does not provide enough evidence, use UNCERTAIN.\n\n" +
    "Return exactly these fields:\n" +
    "SCENE: MATCH, MISMATCH, or UNCERTAIN\n" +
    "REASON: A concise description of visible evidence or why it is inconclusive.";

  // Window-level capture listener stops YouTube Polymer router from hijacking click events
  ["pointerdown", "mousedown", "click"].forEach((evtType) => {
    window.addEventListener(
      evtType,
      (e) => {
        const skipBtn = e.target.closest(".yt-btn-skip");
        if (skipBtn) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          if (evtType === "click" || evtType === "pointerdown") {
            const card = skipBtn.closest(CARD_SELECTORS);
            if (card) executeSkipCard(card);
          }
          return;
        }

        const watchBtn = e.target.closest(".yt-btn-watch");
        if (watchBtn) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          const card = watchBtn.closest(CARD_SELECTORS);
          if (card) {
            card.dataset.dismissWarning = "true";
            hideDashboard(card);
          }
          return;
        }

        if (e.target.closest(".yt-hover-dashboard")) {
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
      },
      true
    );
  });

  function executeSkipCard(card) {
    const v = card.querySelector("video");
    if (v) {
      try {
        v.pause();
        v.currentTime = 0;
      } catch (_) {}
    }
    document
      .querySelectorAll("#inline-preview-player video, ytd-video-preview video, ytd-inline-preview-renderer video")
      .forEach((vid) => {
        try {
          vid.pause();
        } catch (_) {}
      });

    card.dataset.skipped = "true";
    hideDashboard(card);

    card.style.transition = "opacity 0.2s ease, max-height 0.3s ease, margin 0.3s ease";
    card.style.opacity = "0";
    card.style.pointerEvents = "none";
    card.style.maxHeight = "0px";
    card.style.overflow = "hidden";
    card.style.margin = "0px";
    card.style.padding = "0px";

    setTimeout(() => {
      card.style.display = "none";
    }, 280);
  }

  async function getBaseSession() {
    if (baseSession) return baseSession;
    const lm = window.LanguageModel || window.ai?.languageModel;
    if (!lm) return null;

    try {
      baseSession = await lm.create({
        expectedInputs: [{ type: "image" }],
        outputLanguage: "en",
        systemPrompt: SYSTEM_PROMPT
      });
      return baseSession;
    } catch (_) {
      try {
        baseSession = await lm.create({
          outputLanguage: "en",
          systemPrompt: SYSTEM_PROMPT
        });
        return baseSession;
      } catch (__) {
        return null;
      }
    }
  }

  function cleanTitle(raw) {
    return raw
      .replace(/#\w+/g, "")
      .replace(/\[.*?\]|\(.*?\)/g, "")
      .replace(/\b(8K|4K|1080p|HD|UHD|Official|Full\s*HD)\b/gi, "")
      .replace(/\s*\|\s*/g, " - ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function extractVideoKey(card, rawTitle) {
    const link = card.querySelector("a#video-title, a#thumbnail, a[href*='/watch'], a[href*='/shorts/']");
    if (link) {
      const href = link.getAttribute("href") || "";
      const vMatch = href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      if (vMatch) return vMatch[1];
      const shortsMatch = href.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
      if (shortsMatch) return shortsMatch[1];
      if (href.length > 5) return href.split("&")[0];
    }
    return rawTitle.trim().toLowerCase();
  }

  function extractCardMetadata(card) {
    const isShort =
      card.matches("ytd-reel-item-renderer, ytd-rich-grid-slim-media, ytm-shorts-lockup-view-model") ||
      Boolean(card.querySelector('a[href*="/shorts/"]'));

    const titleEl =
      card.querySelector("a#video-title") ||
      card.querySelector("#video-title") ||
      card.querySelector(".yt-lockup-metadata-view-model__title") ||
      card.querySelector("h3") ||
      card.querySelector('a[href*="/shorts/"] span');

    const rawTitle = titleEl ? (titleEl.getAttribute("title") || titleEl.textContent.trim()) : "";

    const channelEl =
      card.querySelector("ytd-channel-name #text") ||
      card.querySelector("#channel-info #text") ||
      card.querySelector(".yt-lockup-metadata-view-model__owner a") ||
      card.querySelector("#channel-name") ||
      card.querySelector(".ytd-channel-name");

    const channelName = channelEl ? channelEl.textContent.trim() : "";

    const videoKey = extractVideoKey(card, rawTitle);

    return {
      rawTitle,
      channelName,
      videoKey,
      isShort
    };
  }

  async function analyzeVideoVisual(card, isShort) {
    const W = isShort ? 45 : 80;
    const H = isShort ? 80 : 45;
    const video = card.querySelector("video");

    if (video && video.videoWidth > 0 && !video.paused) {
      try {
        const canvas1 = document.createElement("canvas");
        canvas1.width = W;
        canvas1.height = H;
        const ctx1 = canvas1.getContext("2d", { willReadFrequently: true });
        ctx1.drawImage(video, 0, 0, W, H);
        const bitmap = await createImageBitmap(canvas1);
        return { bitmap };
      } catch (_) {}
    }

    const thumbArea =
      card.querySelector("ytd-thumbnail, #thumbnail, a#thumbnail") ||
      card.querySelector(".yt-lockup-view-model__content-image") ||
      card;
    const img = thumbArea ? thumbArea.querySelector("img") : card.querySelector("img");

    if (img && img.complete && img.naturalWidth > 0) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, W, H);
        const bitmap = await createImageBitmap(canvas);
        return { bitmap };
      } catch (_) {}
    }

    return { bitmap: null };
  }

  function getMountContainer(card) {
    return (
      card.querySelector("ytd-thumbnail") ||
      card.querySelector(".yt-lockup-view-model__content-image") ||
      card.querySelector("ytd-reel-item-renderer") ||
      card.querySelector("#thumbnail") ||
      card
    );
  }

  function showDashboard(card, status, titleMsg, subtitleMsg, isShort) {
    const mountArea = getMountContainer(card);
    if (!mountArea) return;

    if (getComputedStyle(mountArea).position === "static") {
      mountArea.style.position = "relative";
    }
    mountArea.style.overflow = "visible";

    let dash = mountArea.querySelector(":scope > .yt-hover-dashboard");
    if (!dash) {
      dash = document.createElement("div");
      dash.className = "yt-hover-dashboard";
      mountArea.appendChild(dash);
    }

    dash.className = `yt-hover-dashboard ${status.toLowerCase()}${isShort ? " short-format" : ""}`;
    dash.replaceChildren();

    const titleEl = document.createElement("div");
    titleEl.className = "yt-hover-title";
    titleEl.textContent = titleMsg;

    const subEl = document.createElement("div");
    subEl.className = "yt-hover-subtitle";
    const lines = subtitleMsg.split("\n").filter((l) => l.trim().length > 0);
    lines.slice(0, 4).forEach((line, index) => {
      if (index > 0) subEl.appendChild(document.createElement("br"));
      subEl.appendChild(document.createTextNode(line));
    });

    dash.appendChild(titleEl);
    dash.appendChild(subEl);

    if (status === "FAKE" || status === "UNCERTAIN") {
      const actionsEl = document.createElement("div");
      actionsEl.className = "yt-hover-actions";

      const skipBtn = document.createElement("button");
      skipBtn.className = "yt-btn-skip";
      skipBtn.textContent = "⏭️ Skip";

      const watchBtn = document.createElement("button");
      watchBtn.className = "yt-btn-watch";
      watchBtn.textContent = status === "UNCERTAIN" ? "Dismiss" : "⚠️ Risk";

      actionsEl.appendChild(skipBtn);
      actionsEl.appendChild(watchBtn);
      dash.appendChild(actionsEl);
    }
  }

  function hideDashboard(card) {
    if (!card) return;
    const dash = card.querySelector(".yt-hover-dashboard");
    if (dash) dash.remove();
  }

  function isTargetInsideCardContext(target, card) {
    if (!card || !target) return false;
    if (card.contains(target)) return true;
    if (target.closest?.(".yt-hover-dashboard")) return true;

    const preview = target.closest?.("#inline-preview-player, ytd-video-preview, ytd-inline-preview-renderer");
    if (preview) {
      const pRect = preview.getBoundingClientRect();
      const cRect = card.getBoundingClientRect();
      const overlap = !(
        pRect.right < cRect.left ||
        pRect.left > cRect.right ||
        pRect.bottom < cRect.top ||
        pRect.top > cRect.bottom
      );
      if (overlap) return true;
    }
    return false;
  }

  async function processHover(card) {
    if (card.dataset.dismissWarning === "true" || card.dataset.skipped === "true") return;

    const meta = extractCardMetadata(card);
    if (!meta.rawTitle) return;

    if (verdictCache.has(meta.videoKey)) {
      const cached = verdictCache.get(meta.videoKey);
      showDashboard(card, cached.status, cached.title, cached.subtitle, meta.isShort);
      return;
    }

    if (isPromptExecuting) {
      showDashboard(
        card,
        "uncertain",
        "⚠️ NOT FACT-CHECKED",
        `Source identity: not authenticated (${meta.channelName || "unknown channel"})\n` +
          "Factual claims: not checked against external sources.\n" +
          "Title/frame match: unavailable (analysis is busy).\n" +
          "No conclusion about whether this video is true or false.",
        meta.isShort
      );
      return;
    }

    showDashboard(card, "loading", "⚡ Checking preview scene...", "This does not fact-check video claims.", meta.isShort);

    if (activeAbortController) {
      activeAbortController.abort();
    }
    const currentAbort = new AbortController();
    activeAbortController = currentAbort;

    let bitmap = null;
    try {
      const preview = await analyzeVideoVisual(card, meta.isShort);
      bitmap = preview.bitmap;
      if (currentAbort.signal.aborted) return;

      const sourceLine = `Source identity: not authenticated (${meta.channelName || "unknown channel"})`;
      const factsLine = "Factual claims: not checked against external sources.";
      if (!bitmap) {
        const resultData = {
          status: "UNCERTAIN",
          title: "⚠️ NOT FACT-CHECKED",
          subtitle:
            `${sourceLine}\n${factsLine}\n` +
            "Title/frame match: unavailable (no preview image).\n" +
            "No conclusion about whether this video is true or false."
        };
        verdictCache.set(meta.videoKey, resultData);
        showDashboard(card, resultData.status, resultData.title, resultData.subtitle, meta.isShort);
        return;
      }

      const base = await getBaseSession();
      if (!base) {
        const resultData = {
          status: "UNCERTAIN",
          title: "⚠️ NOT FACT-CHECKED",
          subtitle:
            `${sourceLine}\n${factsLine}\n` +
            "Title/frame match: unavailable (on-device model unavailable).\n" +
            "No conclusion about whether this video is true or false."
        };
        verdictCache.set(meta.videoKey, resultData);
        showDashboard(card, resultData.status, resultData.title, resultData.subtitle, meta.isShort);
        return;
      }

      isPromptExecuting = true;
      const cleaned = cleanTitle(meta.rawTitle);
      const promptText =
        `TITLE: "${cleaned}"\n` +
        "TASK: Assess only whether this single image visibly matches the title. Do not assess factual truth or source identity.\n" +
        "OUTPUT:\nSCENE: MATCH, MISMATCH, or UNCERTAIN\nREASON: concise visible evidence";
      let fullText = "";
      const multiStream = base.promptStreaming(
        [{ role: "user", content: [{ type: "text", value: promptText }, { type: "image", value: bitmap }] }],
        { signal: currentAbort.signal }
      );
      for await (const chunk of multiStream) {
        if (currentAbort.signal.aborted) return;
        fullText += chunk;
      }

      if (currentAbort.signal.aborted) return;

      const sceneMatch = fullText.match(/^\s*SCENE:\s*(MISMATCH|MATCH|UNCERTAIN)\s*$/im);
      const sceneStatus = sceneMatch ? sceneMatch[1].toUpperCase() : "UNCERTAIN";
      const reasonMatch = fullText.match(/^\s*REASON:\s*(.+)$/im);
      const reason = reasonMatch
        ? reasonMatch[1].replace(/[<>]/g, "").trim().slice(0, 180)
        : "The model did not provide a valid scene assessment.";
      const resultData = {
        status: "UNCERTAIN",
        title: "⚠️ NOT FACT-CHECKED",
        subtitle:
          `${sourceLine}\n${factsLine}\n` +
          `Title/frame match: ${sceneStatus.toLowerCase()} (one preview frame only).\n` +
          reason
      };

      verdictCache.set(meta.videoKey, resultData);
      showDashboard(card, resultData.status, resultData.title, resultData.subtitle, meta.isShort);
    } catch (error) {
      if (!currentAbort.signal.aborted) {
        console.error("YouTube preview scene assessment failed:", error);
        const resultData = {
          status: "UNCERTAIN",
          title: "⚠️ NOT FACT-CHECKED",
          subtitle:
            `Source identity: not authenticated (${meta.channelName || "unknown channel"})\n` +
            "Factual claims: not checked against external sources.\n" +
            "Title/frame match: unavailable (analysis failed).\n" +
            "No conclusion about whether this video is true or false."
        };
        showDashboard(card, resultData.status, resultData.title, resultData.subtitle, meta.isShort);
      }
    } finally {
      isPromptExecuting = false;
      if (bitmap && typeof bitmap.close === "function") {
        try {
          bitmap.close();
        } catch (error) {
          console.error("Could not release preview image bitmap:", error);
        }
      }
    }
  }

  function resetRuntimeState() {
    clearTimeout(hoverTimer);
    if (activeAbortController) {
      try {
        activeAbortController.abort();
      } catch (_) {}
      activeAbortController = null;
    }
    isPromptExecuting = false;
    document.querySelectorAll(".yt-hover-dashboard").forEach((d) => d.remove());
    currentCard = null;
  }

  window.addEventListener("yt-navigate-finish", resetRuntimeState, { passive: true });
  window.addEventListener("yt-page-data-updated", resetRuntimeState, { passive: true });
  window.addEventListener("popstate", resetRuntimeState, { passive: true });

  document.addEventListener(
    "pointerover",
    (e) => {
      const card = e.target.closest(CARD_SELECTORS);
      if (!card || card === currentCard) return;

      currentCard = card;
      clearTimeout(hoverTimer);

      hoverTimer = setTimeout(() => {
        processHover(card).catch((error) => {
          console.error("YouTube preview assessment could not be completed:", error);
        });
      }, 60);
    },
    { passive: true }
  );

  document.addEventListener(
    "pointerout",
    (e) => {
      if (!currentCard) return;
      const related = e.relatedTarget;
      if (related && isTargetInsideCardContext(related, currentCard)) {
        return;
      }

      clearTimeout(hoverTimer);
      if (activeAbortController) {
        try {
          activeAbortController.abort();
        } catch (_) {}
        activeAbortController = null;
      }
      hideDashboard(currentCard);
      currentCard = null;
    },
    { passive: true }
  );

  getBaseSession();
})();