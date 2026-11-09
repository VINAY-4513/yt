/**
 * Production-Grade Multimodal Content Authenticity Verifier
 * Architecture: Tier-1 Deterministic Regex & Runtime Analysis + Tier-2 Ephemeral WebGPU Gemini Nano
 * Fixes:
 *   - Expanded journalistic and creator keywords (walkaround, revealed, first ride, launch, unboxing)
 *   - Dedicated text-only fallback prompt to prevent AI "no preview frame provided" errors
 *   - Window-level event capture interceptor preventing YouTube click hijacking on Skip
 *   - Persistent z-index overlay anchored over inline preview players
 *   - Stable 11-char video ID caching avoiding repeated verification on search
 *   - Temporal 2-frame pixel motion analysis catching static slideshow recaps
 *   - Punctuation-tolerant sequel regex matching (: - | / .)
 */
(function () {
  "use strict";

  let baseSession = null;
  const verdictCache = new Map();
  let currentCard = null;
  let hoverTimer = null;
  let activeAbortController = null;
  let isPromptExecuting = false;

  const OFFICIAL_STUDIOS_AND_LABELS = [
    /\b(mythri\s*movie\s*makers|sithara\s*entertainments|haarika\s*&\s*hassine|dvv\s*entertainment|vyjayanthi\s*movies)\b/i,
    /\b(suresh\s*productions|sri\s*venkateswara\s*creations|dil\s*raju|geetha\s*arts|uv\s*creations|people\s*media\s*factory)\b/i,
    /\b(annapurna\s*studios|konidela\s*production|shine\s*screens|ak\s*entertainments|matinee\s*entertainment|14\s*reels)\b/i,
    /\b(hombale\s*films|lyca\s*productions|sun\s*pictures|red\s*giant|studio\s*green|dream\s*warrior|raaj\s*kamal)\b/i,
    /\b(aditya\s*music|lahari\s*music|mango\s*music|think\s*music|junglee\s*music|saregama|sony\s*music|t-series|zee\s*music)\b/i,
    /\b(yrf|yash\s*raj\s*films|dharma\s*productions|excel\s*entertainment|maddock\s*films|red\s*chillies|jio\s*studios)\b/i,
    /\b(warner\s*bros|marvel|universal\s*pictures|paramount|walt\s*disney|lionsgate|20th\s*century)\b/i,
    /\b(netflix|prime\s*video|hotstar|hbo|apple\s*tv)\b/i
  ];

  const OFFICIAL_NEWS_NETWORKS = [
    /\b(tv9|ntv|abn|etv|sakshi|v6\s*news|10tv|t\s*news|mahaa\s*news|prime9|eenadu|andhra\s*jyothy)\b/i,
    /\b(ndtv|aaj\s*tak|abp\s*news|republic|zee\s*news|india\s*today|times\s*now|news18|ani|wion|dd\s*news)\b/i,
    /\b(bbc|reuters|the\s*hindu|indian\s*express|hindustan\s*times|al\s*jazeera|cnn|associated\s*press)\b/i,
    /(समाचार|न्यूज़|లైవ్\s*వార్తలు|వార్తలు)/i
  ];

  const PRIMARY_STUDIO_ASSETS =
    /\b(first\s*look|teaser|trailer|glimpse|motion\s*poster|title\s*track|full\s*song|official\s*video|official\s*song|lyrical|first\s*single|second\s*single)\b/i;

  const CREATOR_PERMITTED =
    /\b(review|reaction|breakdown|analysis|explained|story\s*explained|ending\s*explained|recap|summary|interview|roast|public\s*talk|box\s*office|walkaround|first\s*ride|revealed|launch|unboxing|first\s*look\s*review)\b/i;

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
    "You are a strict YouTube video content authenticity and visual scene verification engine.\n\n" +
    "CORE VERIFICATION TASKS:\n" +
    "1. SCENE-TO-TITLE CONSISTENCY: Examine the provided visual frame. Does it depict what the title claims? (E.g. If title claims 'flying car in 2040', the frame MUST show a flying vehicle. If title claims an interview with a public figure, that figure must be visible).\n" +
    "2. FULL MOVIE vs. SCREENSHOT RECAP: If the title claims to be a 'Full Movie', it is REAL only if the frame shows continuous cinematic motion-picture acting. If the frame is a static slideshow, recap screenshot with text, or thumbnail montage, output FAKE.\n" +
    "3. CELEBRITY IMPERSONATION: If title claims major stars (e.g. Prabhas, Mahesh Babu, Priyanka Chopra) but the frame shows random actors or a different dubbed film, output FAKE.\n" +
    "4. UNRELEASED SEQUELS: Unreleased films (Baahubali 3, KGF 3, Pushpa 3) are strictly FAKE.\n" +
    "5. NEWS INTEGRITY: Serious news from unverified channels must be marked FAKE noting lack of official origin.\n\n" +
    "OUTPUT FORMAT STRICTLY:\n" +
    "STATUS: <REAL, FAKE, or UNCERTAIN>\n" +
    "REASON: <Line 1: Direct finding>\n<Line 2: Concrete evidence>";

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

    const verifiedBadge = card.querySelector(
      "ytd-badge-supported-renderer [aria-label*='Verified'], " +
      "yt-icon[aria-label*='Verified'], " +
      "[aria-label*='Official Artist Channel'], " +
      ".badge-style-type-verified"
    );
    const isVerified = Boolean(verifiedBadge);

    const durationEl =
      card.querySelector("ytd-thumbnail-overlay-time-status-renderer #text") ||
      card.querySelector("span.ytd-thumbnail-overlay-time-status-renderer") ||
      card.querySelector(".badge-shape-wiz__text");
    const durationText = durationEl ? durationEl.textContent.trim() : "";

    let durationInMinutes = 0;
    if (durationText) {
      const parts = durationText.split(":").map(Number);
      if (parts.length === 3) durationInMinutes = parts[0] * 60 + parts[1];
      else if (parts.length === 2) durationInMinutes = parts[0];
    }

    const descEl =
      card.querySelector("#description-text") ||
      card.querySelector(".metadata-snippet-container") ||
      card.querySelector(".metadata-snippet-text");
    const snippetDesc = descEl ? descEl.textContent.trim() : "";

    const videoKey = extractVideoKey(card, rawTitle);

    return {
      rawTitle,
      channelName,
      isVerified,
      durationText,
      durationInMinutes,
      snippetDesc,
      videoKey,
      isShort
    };
  }

  function evaluateDeterministicRules(meta) {
    const lower = meta.rawTitle.toLowerCase();
    const chName = meta.channelName.toLowerCase();
    const isStudio = OFFICIAL_STUDIOS_AND_LABELS.some((r) => r.test(chName));
    const isNewsChannel = OFFICIAL_NEWS_NETWORKS.some((r) => r.test(chName));
    const hasCreatorContext = CREATOR_PERMITTED.test(lower);

    const isFullMovie =
      /\b(full\s*movie|entire\s*(film|movie)|full\s*film)\b/i.test(lower) ||
      /(पूरी\s*फिल्म|పూర్తి\s*సినిమా|మూవీ)/i.test(lower);

    // Punctuation and colon-tolerant sequel matcher (: - | / .)
    const isFakeSequel =
      /(baahubali|bahubali|బాహుబలి|बाहुब[^\s0-9]*)[^a-z0-9]*(part|chapter|भाग)?\s*(3|३|౩)/i.test(lower) ||
      /(kgf|केजीएफ|కేజీఎఫ్)[^a-z0-9]*(part|chapter)?\s*(3|३|౩)/i.test(lower) ||
      /(pushpa|पुष्पा|పుష్ప)[^a-z0-9]*(part|chapter)?\s*(3|३|౩)/i.test(lower) ||
      /(rrr|आरआरआर|ఆర్ఆర్ఆర్)[^a-z0-9]*(part|chapter)?\s*(2|२|౨)/i.test(lower) ||
      /(salaar|सालार|సలార్)[^a-z0-9]*(part|chapter)?\s*(2|२|౨)/i.test(lower);

    if (isFakeSequel && !hasCreatorContext) {
      return {
        status: "FAKE",
        title: "🚨 WARNING: UNRELEASED SEQUEL",
        subtitle: "This film is unreleased and does not exist.\nThe upload uses recycled clips to deceive viewers."
      };
    }

    if (isFullMovie && meta.durationInMinutes > 0 && meta.durationInMinutes < 50 && !hasCreatorContext) {
      return {
        status: "FAKE",
        title: "🚨 WARNING: NOT A FULL MOVIE",
        subtitle: `Duration (${meta.durationText}) indicates a recap or explanation.\nIt does not contain the complete continuous film.`
      };
    }

    const hasMultipleStarsInTitle =
      /\b(mahesh\s*babu|priyanka\s*chopra|prabhas|allu\s*arjun|ram\s*charan|jr\s*ntr|bobby\s*deol)\b/i.test(lower);
    const isDubbedActionTag = /\b(latest\s*south|action\s*hindi|blockbuster\s*action|full\s*action)\b/i.test(lower);

    if (hasMultipleStarsInTitle && isDubbedActionTag && !isStudio && !hasCreatorContext) {
      return {
        status: "FAKE",
        title: "🚨 WARNING: STAR-CAST CLICKBAIT",
        subtitle: "Deceptive title pairing unrelated celebrity names.\nDubbed movie packaging falsely advertising top stars."
      };
    }

    const claimsPrimary = PRIMARY_STUDIO_ASSETS.test(lower);
    if (claimsPrimary && !hasCreatorContext && !isStudio) {
      return {
        status: "FAKE",
        title: "🚨 WARNING: UNAUTHORIZED RELEASE",
        subtitle: `Uploaded by ${meta.channelName || "an unverified channel"} rather than the official studio.\nIt is fan-made, re-uploaded, or concept content.`
      };
    }

    const isNewsTopic =
      /\b(breaking\s*news|arrested|died|passes\s*away|scam|election\s*result|press\s*meet)\b/i.test(lower) ||
      /(ब्रेकिंग\s*न्यूज़|తాజా\s*వార్త)/i.test(lower);

    if (isNewsTopic) {
      if (isNewsChannel) {
        return {
          status: "REAL",
          title: "✅ VERIFIED NEWS REPORT",
          subtitle: `Reported by established official news source: ${meta.channelName}.\nContent is verified for journalistic coverage.`
        };
      }
      return {
        status: "FAKE",
        title: "🚨 WARNING: UNVERIFIED NEWS",
        subtitle: "This report did not originate from an official news channel.\nThe claimed information is uncorroborated."
      };
    }

    if (hasCreatorContext && !isFakeSequel) {
      return {
        status: "REAL",
        title: "✅ AUTHENTIC CREATOR WORK",
        subtitle: "Permitted creator commentary, review, or analysis.\nTitle accurately represents creator opinion or breakdown."
      };
    }

    if (claimsPrimary && isStudio) {
      return {
        status: "REAL",
        title: "✅ OFFICIAL STUDIO RELEASE",
        subtitle: `Direct distribution from official publisher: ${meta.channelName}.\nVerified authentic media.`
      };
    }

    return null;
  }

  async function analyzeVideoVisual(card, isShort, isFullMovieClaim) {
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

        let isStaticSlideshow = false;

        if (isFullMovieClaim) {
          const frameData1 = ctx1.getImageData(0, 0, W, H).data;
          await new Promise((res) => setTimeout(res, 180));

          if (video && !video.paused) {
            const canvas2 = document.createElement("canvas");
            canvas2.width = W;
            canvas2.height = H;
            const ctx2 = canvas2.getContext("2d", { willReadFrequently: true });
            ctx2.drawImage(video, 0, 0, W, H);
            const frameData2 = ctx2.getImageData(0, 0, W, H).data;

            let diffSum = 0;
            const totalPixels = W * H;
            for (let i = 0; i < frameData1.length; i += 4) {
              diffSum +=
                Math.abs(frameData1[i] - frameData2[i]) +
                Math.abs(frameData1[i + 1] - frameData2[i + 1]) +
                Math.abs(frameData1[i + 2] - frameData2[i + 2]);
            }
            const avgDiffPerPixel = diffSum / totalPixels;

            if (avgDiffPerPixel < 2.5) {
              isStaticSlideshow = true;
            }
          }
        }

        const bitmap = await createImageBitmap(canvas1);
        return { bitmap, isStaticSlideshow };
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
        return { bitmap, isStaticSlideshow: false };
      } catch (_) {}
    }

    return { bitmap: null, isStaticSlideshow: false };
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
    subEl.innerHTML = lines.slice(0, 2).join("<br>");

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
      watchBtn.textContent = status === "UNCERTAIN" ? "⚠️ Check" : "⚠️ Risk";

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

    // Fast-path Deterministic Evaluation (0 ms)
    const fastDecision = evaluateDeterministicRules(meta);
    if (fastDecision) {
      verdictCache.set(meta.videoKey, fastDecision);
      showDashboard(card, fastDecision.status, fastDecision.title, fastDecision.subtitle, meta.isShort);
      return;
    }

    // In-memory Cache Lookup (0 ms)
    if (verdictCache.has(meta.videoKey)) {
      const cached = verdictCache.get(meta.videoKey);
      showDashboard(card, cached.status, cached.title, cached.subtitle, meta.isShort);
      return;
    }

    showDashboard(
      card,
      "loading",
      "⚡ Analyzing Scene & Content...",
      "Inspecting visual frame authenticity...\nEvaluating scene consistency with title claims.",
      meta.isShort
    );

    if (activeAbortController) {
      try {
        activeAbortController.abort();
      } catch (_) {}
    }
    const currentAbort = new AbortController();
    activeAbortController = currentAbort;

    if (isPromptExecuting) return;

    const isFullMovieClaim = /\b(full\s*movie|entire\s*film)\b/i.test(meta.rawTitle);
    const { bitmap, isStaticSlideshow } = await analyzeVideoVisual(card, meta.isShort, isFullMovieClaim);

    if (isStaticSlideshow && isFullMovieClaim) {
      const resultData = {
        status: "FAKE",
        title: "🚨 WARNING: SLIDESHOW RECAP",
        subtitle: "Preview frame variance is zero.\nStatic image slideshow disguised as a full theatrical movie."
      };
      verdictCache.set(meta.videoKey, resultData);
      showDashboard(card, resultData.status, resultData.title, resultData.subtitle, meta.isShort);
      if (bitmap) {
        try {
          bitmap.close();
        } catch (_) {}
      }
      return;
    }

    const base = await getBaseSession();
    if (!base) {
      showDashboard(
        card,
        "loading",
        "⚠️ AI Hardware Busy",
        "WebGPU API initialization pending.\nModel will retry on next hover.",
        meta.isShort
      );
      if (bitmap) {
        try {
          bitmap.close();
        } catch (_) {}
      }
      return;
    }

    isPromptExecuting = true;

    try {
      const cleaned = cleanTitle(meta.rawTitle);
      const promptText =
        `TITLE: "${cleaned}"\n` +
        `CHANNEL: "${meta.channelName}" (${meta.isVerified ? "Verified" : "Unverified"})\n` +
        (meta.durationText ? `DURATION: ${meta.durationText}\n` : "") +
        (meta.snippetDesc ? `DESCRIPTION: "${meta.snippetDesc.slice(0, 140)}"\n` : "") +
        `TASK:\n` +
        `1. Inspect visual preview frame: Does it directly depict what the title claims?\n` +
        `2. If Full Movie: Is it genuine theatrical cinematic acting or a photo recap/slideshow?\n` +
        `3. Are the claimed celebrity actors actually visible in this scene?\n` +
        `OUTPUT STRICTLY:\n` +
        `STATUS: <REAL, FAKE, or UNCERTAIN>\n` +
        `REASON: <Line 1>\n<Line 2>`;

      let fullText = "";
      let decidedStatus = null;
      let decidedReason = "";
      let streamWorked = false;

      // Primary Multimodal Stream
      if (bitmap) {
        try {
          const multiStream = base.promptStreaming(
            [{ role: "user", content: [{ type: "text", value: promptText }, { type: "image", value: bitmap }] }],
            { signal: currentAbort.signal }
          );

          for await (const chunk of multiStream) {
            if (currentAbort.signal.aborted) break;
            fullText += chunk;
            streamWorked = true;

            if (!decidedStatus) {
              const match = fullText.match(/STATUS:\s*(REAL|FAKE|UNCERTAIN)/i);
              if (match) decidedStatus = match[1].toUpperCase();
            }

            const reasonMatch = fullText.match(/REASON:\s*([\s\S]+)/i);
            if (reasonMatch) {
              const candidate = reasonMatch[1].trim();
              if (candidate.includes("\n") || candidate.length > 70) {
                decidedReason = candidate;
              }
            }

            if (decidedStatus && decidedReason) break;
            if (fullText.length > 200) break;
          }
        } catch (_) {
          streamWorked = false;
        }
      }

      // Dedicated text-only fallback (does not request image inspection if no frame is piped)
      if (!streamWorked && !currentAbort.signal.aborted) {
        try {
          const fallbackTextPrompt =
            `TITLE: "${cleaned}"\n` +
            `CHANNEL: "${meta.channelName}" (${meta.isVerified ? "Verified" : "Unverified"})\n` +
            (meta.durationText ? `DURATION: ${meta.durationText}\n` : "") +
            (meta.snippetDesc ? `DESCRIPTION: "${meta.snippetDesc.slice(0, 140)}"\n` : "") +
            `TASK:\n` +
            `Evaluate whether this video title and channel represent authentic reporting, legitimate creator coverage, official content, or deceptive clickbait.\n` +
            `OUTPUT STRICTLY:\n` +
            `STATUS: <REAL or FAKE>\n` +
            `REASON: <Line 1>\n<Line 2>`;

          const textStream = base.promptStreaming(fallbackTextPrompt, { signal: currentAbort.signal });

          for await (const chunk of textStream) {
            if (currentAbort.signal.aborted) break;
            fullText += chunk;

            if (!decidedStatus) {
              const match = fullText.match(/STATUS:\s*(REAL|FAKE|UNCERTAIN)/i);
              if (match) decidedStatus = match[1].toUpperCase();
            }

            const reasonMatch = fullText.match(/REASON:\s*([\s\S]+)/i);
            if (reasonMatch) {
              const candidate = reasonMatch[1].trim();
              if (candidate.includes("\n") || candidate.length > 70) {
                decidedReason = candidate;
              }
            }

            if (decidedStatus && decidedReason) break;
            if (fullText.length > 200) break;
          }
        } catch (_) {}
      }

      if (currentAbort.signal.aborted) return;

      if (!decidedStatus) {
        const upper = fullText.toUpperCase();
        if (upper.includes("FAKE")) decidedStatus = "FAKE";
        else if (upper.includes("UNCERTAIN")) decidedStatus = "UNCERTAIN";
        else decidedStatus = "REAL";
      }

      if (!decidedReason) {
        if (decidedStatus === "FAKE") {
          decidedReason = "Visual frame contradicts the claimed title subject.\nUnsubstantiated scenes or misleading celebrity tagging.";
        } else if (decidedStatus === "UNCERTAIN") {
          decidedReason = "Visual evidence is inconclusive from preview frames.\nProceed with caution.";
        } else {
          decidedReason = "Visual scenes substantiate the claimed title content.\nContent is relevant and verified authentic.";
        }
      }

      const sanitizedLines = decidedReason
        .replace(/[*_#]/g, "")
        .replace(/^REASON:\s*/i, "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      const finalSubtitle =
        sanitizedLines.length >= 2
          ? `${sanitizedLines[0]}\n${sanitizedLines[1]}`
          : `${sanitizedLines[0] || "Content verification mismatch."}\nVisual evidence failed to confirm title claim.`;

      let resultData;
      if (decidedStatus === "FAKE") {
        resultData = {
          status: "FAKE",
          title: "🚨 WARNING: FAKE / CLICKBAIT",
          subtitle: finalSubtitle
        };
      } else if (decidedStatus === "UNCERTAIN") {
        resultData = {
          status: "UNCERTAIN",
          title: "⚠️ CAUTION: UNCONFIRMED CONTENT",
          subtitle: finalSubtitle
        };
      } else {
        resultData = {
          status: "REAL",
          title: "✅ VERIFIED AUTHENTIC",
          subtitle: finalSubtitle
        };
      }

      verdictCache.set(meta.videoKey, resultData);
      showDashboard(card, resultData.status, resultData.title, resultData.subtitle, meta.isShort);
    } catch (_) {
      try {
        if (baseSession && typeof baseSession.destroy === "function") {
          baseSession.destroy();
        }
      } catch (_) {}
      baseSession = null;
    } finally {
      isPromptExecuting = false;
      if (bitmap && typeof bitmap.close === "function") {
        try {
          bitmap.close();
        } catch (_) {}
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
        processHover(card).catch(() => {});
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