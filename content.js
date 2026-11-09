/**
 * YouTube preview-scene assessment.
 * Factual claims and publisher identity are not verified without external sources.
 */
(function () {
  "use strict";

  let baseSession = null;
  let baseSessionPromise = null;
  const verdictCache = new Map();
  let currentCard = null;
  let pendingCard = null;
  let hoverTimer = null;
  let activeAbortController = null;
  let isPromptExecuting = false;
  const MAX_VERDICT_CACHE_ENTRIES = 100;
  const VERDICT_CACHE_TTL_MS = 10 * 60 * 1000;

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
    "Assess only whether the supplied preview frames visibly match the video title. " +
    "A few preview frames cannot establish the truth of factual claims, the identity of a publisher, " +
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

  function getBaseSession() {
    if (baseSession) return Promise.resolve(baseSession);
    if (baseSessionPromise) return baseSessionPromise;
    const lm = window.LanguageModel || window.ai?.languageModel;
    if (!lm) return Promise.resolve(null);

    baseSessionPromise = lm.create({
      expectedInputs: [{ type: "image" }],
      outputLanguage: "en",
      systemPrompt: SYSTEM_PROMPT
    })
      .then((session) => {
        baseSession = session;
        return session;
      })
      .catch((error) => {
        console.error("Could not initialize the image-capable on-device model:", error);
        return null;
      })
      .finally(() => {
        baseSessionPromise = null;
      });
    return baseSessionPromise;
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

    const descriptionEl =
      card.querySelector("#description-text") ||
      card.querySelector(".metadata-snippet-container") ||
      card.querySelector(".metadata-snippet-text");
    const snippetDesc = descriptionEl ? descriptionEl.textContent.trim().slice(0, 1000) : "";

    const videoKey = extractVideoKey(card, rawTitle);

    return {
      rawTitle,
      channelName,
      snippetDesc,
      videoKey,
      isShort
    };
  }

  function getVerdictCacheKey(meta) {
    return `${meta.videoKey}\n${meta.rawTitle}\n${meta.channelName}\n${meta.snippetDesc}`;
  }

  function getCachedVerdict(key) {
    const entry = verdictCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > VERDICT_CACHE_TTL_MS) {
      verdictCache.delete(key);
      return null;
    }
    verdictCache.delete(key);
    verdictCache.set(key, entry);
    return entry.result;
  }

  function cacheVerdict(key, result) {
    verdictCache.delete(key);
    verdictCache.set(key, { result, createdAt: Date.now() });
    while (verdictCache.size > MAX_VERDICT_CACHE_ENTRIES) {
      verdictCache.delete(verdictCache.keys().next().value);
    }
  }

  function searchRelatedFactChecks(query) {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      return Promise.resolve({ ok: false, error: "Extension messaging is unavailable." });
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "fact-check-search", query }, (response) => {
        if (chrome.runtime.lastError) {
          console.error("Could not contact local fact-check backend:", chrome.runtime.lastError);
          resolve({ ok: false, error: "Local fact-check backend is unavailable." });
          return;
        }
        if (!response?.ok) {
          resolve({
            ok: false,
            error: String(response?.error || "Fact-check search failed.").slice(0, 120)
          });
          return;
        }
        resolve({
          ok: true,
          matches: Array.isArray(response.matches) ? response.matches.slice(0, 5) : []
        });
      });
    });
  }

  function factCheckSummary(result) {
    if (!result.ok) return `Fact-check search unavailable: ${result.error}`;
    if (result.matches.length === 0) {
      return "Fact-check search: no related references found; absence is not evidence.";
    }
    return `Fact-check search: ${result.matches.length} related reference(s); this is not a verdict.`;
  }

  function waitForPreviewFrame(signal, delayMs) {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timeout = setTimeout(finish, delayMs);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  async function analyzeVideoVisual(card, isShort, signal) {
    const W = isShort ? 45 : 80;
    const H = isShort ? 80 : 45;
    const video = card.querySelector("video");

    if (video && video.videoWidth > 0 && !video.paused) {
      try {
        const frameCount = 3;
        const canvas = document.createElement("canvas");
        canvas.width = W * frameCount;
        canvas.height = H;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Could not create preview-frame canvas context.");

        for (let frame = 0; frame < frameCount; frame += 1) {
          if (signal.aborted) return { bitmap: null, sampledFrames: 0 };
          if (frame > 0) {
            await waitForPreviewFrame(signal, 250);
          }
          if (signal.aborted || video.paused || video.videoWidth === 0) {
            return { bitmap: null, sampledFrames: 0 };
          }
          ctx.drawImage(video, frame * W, 0, W, H);
        }

        const bitmap = await createImageBitmap(canvas);
        return { bitmap, sampledFrames: frameCount };
      } catch (error) {
        if (!signal.aborted) console.error("Could not sample preview video frames:", error);
      }
    }

    if (signal.aborted) return { bitmap: null, sampledFrames: 0 };

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
        if (!ctx) throw new Error("Could not create thumbnail canvas context.");
        ctx.drawImage(img, 0, 0, W, H);
        const bitmap = await createImageBitmap(canvas);
        return { bitmap, sampledFrames: 1 };
      } catch (error) {
        console.error("Could not capture preview thumbnail:", error);
      }
    }

    return { bitmap: null, sampledFrames: 0 };
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

  function showDashboard(card, status, titleMsg, subtitleMsg, isShort, sources = []) {
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
    lines.slice(0, 5).forEach((line, index) => {
      if (index > 0) subEl.appendChild(document.createElement("br"));
      subEl.appendChild(document.createTextNode(line));
    });

    dash.appendChild(titleEl);
    dash.appendChild(subEl);

    if (sources.length > 0) {
      const sourceList = document.createElement("div");
      sourceList.className = "yt-hover-sources";
      sources.forEach((source) => {
        try {
          const url = new URL(source.url);
          if (url.protocol !== "https:") return;
          const link = document.createElement("a");
          link.href = url.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = `${source.publisher || "Fact-check"}: ${source.title || source.claimText || "Review"}${source.rating ? ` — ${source.rating}` : ""}`;
          sourceList.appendChild(link);
        } catch (error) {
          console.error("Ignoring invalid fact-check reference URL:", error);
        }
      });
      if (sourceList.childElementCount > 0) dash.appendChild(sourceList);
    }

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
    if (card !== currentCard || !card.isConnected) return;
    if (card.dataset.dismissWarning === "true" || card.dataset.skipped === "true") return;

    const meta = extractCardMetadata(card);
    if (!meta.rawTitle) return;

    const cacheKey = getVerdictCacheKey(meta);
    const cached = getCachedVerdict(cacheKey);
    if (cached) {
      showDashboard(card, cached.status, cached.title, cached.subtitle, meta.isShort, cached.sources);
      return;
    }

    if (isPromptExecuting) {
      pendingCard = card;
      showDashboard(
        card,
        "loading",
        "⏳ Analysis queued",
        "This does not fact-check video claims.",
        meta.isShort
      );
      return;
    }

    showDashboard(card, "loading", "⚡ Checking preview scene...", "This does not fact-check video claims.", meta.isShort);

    const currentAbort = new AbortController();
    activeAbortController = currentAbort;
    isPromptExecuting = true;

    let bitmap = null;
    try {
      const sourceLine = `Source identity: not authenticated (${meta.channelName || "unknown channel"})`;
      const factsLine = "Factual claims: not verified; title search is contextual only.";
      const factCheckPromise = searchRelatedFactChecks(meta.rawTitle);
      const preview = await analyzeVideoVisual(card, meta.isShort, currentAbort.signal);
      bitmap = preview.bitmap;
      if (currentAbort.signal.aborted) return;

      if (!bitmap) {
        const factChecks = await factCheckPromise;
        showDashboard(
          card,
          "uncertain",
          "⚠️ NOT FACT-CHECKED",
          `${sourceLine}\n${factsLine}\n` +
            `Title/frame match: unavailable (no preview image).\n${factCheckSummary(factChecks)}`,
          meta.isShort,
          factChecks.ok ? factChecks.matches.slice(0, 2) : []
        );
        return;
      }

      const base = await getBaseSession();
      if (!base) {
        const factChecks = await factCheckPromise;
        showDashboard(
          card,
          "uncertain",
          "⚠️ NOT FACT-CHECKED",
          `${sourceLine}\n${factsLine}\n` +
            `Title/frame match: unavailable (on-device model unavailable).\n${factCheckSummary(factChecks)}`,
          meta.isShort,
          factChecks.ok ? factChecks.matches.slice(0, 2) : []
        );
        return;
      }

      const promptText =
        `TITLE: ${JSON.stringify(meta.rawTitle)}\n` +
        (meta.snippetDesc ? `VISIBLE DESCRIPTION CONTEXT: ${JSON.stringify(meta.snippetDesc)}\n` : "") +
        `The image is a contact sheet of ${preview.sampledFrames} ${preview.sampledFrames === 1 ? "preview frame" : "preview frames"}.\n` +
        "Assess only whether these sampled images visibly match the title in context. Do not assess factual truth, source identity, or the whole video.\n" +
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
      const factChecks = await factCheckPromise;
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
          `Title/frame match: ${sceneStatus.toLowerCase()} (${preview.sampledFrames} sampled ${preview.sampledFrames === 1 ? "frame" : "frames"}; not full-video verification).\n` +
          `${factCheckSummary(factChecks)}\n${reason}`,
        sources: factChecks.ok ? factChecks.matches.slice(0, 2) : []
      };

      if (sceneMatch) cacheVerdict(cacheKey, resultData);
      showDashboard(card, resultData.status, resultData.title, resultData.subtitle, meta.isShort, resultData.sources);
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
      if (activeAbortController === currentAbort) activeAbortController = null;
      if (bitmap && typeof bitmap.close === "function") {
        try {
          bitmap.close();
        } catch (error) {
          console.error("Could not release preview image bitmap:", error);
        }
      }
      const nextCard = pendingCard;
      pendingCard = null;
      if (nextCard && nextCard.isConnected && nextCard === currentCard) {
        setTimeout(() => {
          processHover(nextCard).catch((error) => {
            console.error("Queued YouTube preview assessment could not be completed:", error);
          });
        }, 0);
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
    pendingCard = null;
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
      const card = e.target.closest(CARD_SELECTORS);
      if (!currentCard || card !== currentCard) return;
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
      if (pendingCard === currentCard) pendingCard = null;
      hideDashboard(currentCard);
      currentCard = null;
    },
    { passive: true }
  );

  getBaseSession();
})();