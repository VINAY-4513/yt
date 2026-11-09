"use strict";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "fact-check-search") return false;
  if (typeof message.query !== "string" || !message.query.trim() || message.query.length > 1000) {
    sendResponse({ ok: false, error: "Search query must be between 1 and 1000 characters." });
    return false;
  }

  fetch("http://127.0.0.1:3000/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: message.query.trim() }),
    signal: AbortSignal.timeout(10000)
  })
    .then(async (response) => {
      const result = await response.json();
      if (!response.ok) {
        sendResponse({ ok: false, error: result.error || `Fact-check backend returned HTTP ${response.status}.` });
        return;
      }
      sendResponse({ ok: true, matches: result.matches || [] });
    })
    .catch((error) => {
      console.error("Fact-check search request failed:", error);
      sendResponse({ ok: false, error: "Local fact-check backend is unavailable." });
    });

  return true;
});
