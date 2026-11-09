"use strict";

const http = require("node:http");
const { URL } = require("node:url");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_RESULTS = 5;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  let body = "";
  let byteLength = 0;
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > MAX_BODY_BYTES) {
      const error = new Error("Request body exceeds the allowed size.");
      error.statusCode = 413;
      throw error;
    }
    body += chunk.toString("utf8");
  }

  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function normalizeMatches(claims) {
  const matches = [];
  for (const claim of claims || []) {
    for (const review of claim.claimReview || []) {
      const url = safeHttpsUrl(review.url);
      if (!url) continue;
      matches.push({
        claimText: String(claim.text || "").slice(0, 500),
        claimant: String(claim.claimant || "").slice(0, 160),
        publisher: String(review.publisher?.name || "").slice(0, 160),
        title: String(review.title || "").slice(0, 240),
        rating: String(review.textualRating || "").slice(0, 120),
        reviewDate: String(review.reviewDate || "").slice(0, 40),
        url
      });
      if (matches.length >= MAX_RESULTS) return matches;
    }
  }
  return matches;
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${HOST}:${PORT}`);
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method !== "POST" || requestUrl.pathname !== "/api/search") {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message });
    return;
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 1000) {
    sendJson(response, 400, { error: "Query must be between 1 and 1000 characters." });
    return;
  }

  const apiKey = process.env.GOOGLE_FACT_CHECK_API_KEY;
  if (!apiKey) {
    sendJson(response, 503, { error: "GOOGLE_FACT_CHECK_API_KEY is not configured." });
    return;
  }

  const apiUrl = new URL("https://factchecktools.googleapis.com/v1alpha1/claims:search");
  apiUrl.searchParams.set("query", query);
  apiUrl.searchParams.set("pageSize", String(MAX_RESULTS));
  apiUrl.searchParams.set("key", apiKey);

  try {
    const upstream = await fetch(apiUrl, { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) {
      console.error("Google Fact Check API returned HTTP", upstream.status);
      sendJson(response, upstream.status === 429 ? 429 : 502, {
        error: "Google Fact Check API search failed."
      });
      return;
    }

    const data = await upstream.json();
    sendJson(response, 200, { matches: normalizeMatches(data.claims) });
  } catch (error) {
    console.error("Google Fact Check API request failed:", error);
    sendJson(response, 502, { error: "Google Fact Check API is unavailable." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Fact-check search backend listening on http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
  console.error("Fact-check backend failed to start:", error);
  process.exitCode = 1;
});
