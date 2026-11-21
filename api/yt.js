const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const MAX_QUERY_LENGTH = 200;
const MAX_RESULTS = 50;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(payload));
}

function readSingleQuery(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_RESULTS) : fallback;
}

function buildEndpointAndParams(query) {
  const type = readSingleQuery(query.type || "search").toLowerCase();
  const videoId = readSingleQuery(query.videoId || query.id);
  const channelId = readSingleQuery(query.channelId);
  const searchTerm = readSingleQuery(query.q || query.query);
  const maxResults = parsePositiveInteger(query.maxResults, 10);

  if (!["video", "search", "channel"].includes(type)) {
    return { error: { status: 400, code: "INVALID_TYPE", message: "Type must be video, search, or channel." } };
  }

  if (videoId && !VIDEO_ID_PATTERN.test(videoId)) {
    return { error: { status: 400, code: "INVALID_VIDEO_ID", message: "The video ID is invalid." } };
  }

  if (channelId && !CHANNEL_ID_PATTERN.test(channelId)) {
    return { error: { status: 400, code: "INVALID_CHANNEL_ID", message: "The channel ID is invalid." } };
  }

  if (searchTerm.length > MAX_QUERY_LENGTH) {
    return { error: { status: 400, code: "QUERY_TOO_LONG", message: `Search query must be ${MAX_QUERY_LENGTH} characters or fewer.` } };
  }

  if (type === "video" && videoId) {
    return {
      endpoint: "videos",
      params: { part: "snippet,contentDetails,statistics", id: videoId },
    };
  }

  if (type === "channel" && channelId && !searchTerm) {
    return {
      endpoint: "channels",
      params: { part: "snippet,contentDetails,statistics", id: channelId },
    };
  }

  if (!searchTerm) {
    return {
      error: {
        status: 400,
        code: "MISSING_QUERY",
        message: type === "video"
          ? "Provide a videoId or a search query."
          : "Provide a search query or channelId.",
      },
    };
  }

  const params = { part: "snippet", q: searchTerm, type: type === "channel" ? "channel" : "video", maxResults };
  if (channelId) params.channelId = channelId;
  if (type === "video") params.videoEmbeddable = "true";
  return { endpoint: "search", params };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return sendJson(res, 405, {
        success: false,
        error: { code: "METHOD_NOT_ALLOWED", message: "Only GET requests are supported." },
      });
    }

    const query = req.query && typeof req.query === "object" ? req.query : {};
    const request = buildEndpointAndParams(query);
    if (request.error) {
      return sendJson(res, request.error.status, {
        success: false,
        error: { code: request.error.code, message: request.error.message },
      });
    }

    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      return sendJson(res, 503, {
        success: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "The YouTube data service is not configured." },
      });
    }

    const url = new URL(`${YOUTUBE_API_BASE}/${request.endpoint}`);
    for (const [key, value] of Object.entries(request.params)) url.searchParams.set(key, value);
    url.searchParams.set("key", apiKey);

    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      return sendJson(res, response.status === 404 ? 404 : 502, {
        success: false,
        error: {
          code: response.status === 404 ? "NOT_FOUND" : "UPSTREAM_ERROR",
          message: response.status === 404
            ? "The requested YouTube resource was not found."
            : "The YouTube data service could not complete the request.",
        },
      });
    }

    const data = await response.json();
    if (!data || !Array.isArray(data.items)) {
      return sendJson(res, 502, {
        success: false,
        error: { code: "INVALID_UPSTREAM_RESPONSE", message: "The YouTube data service returned an invalid response." },
      });
    }

    return sendJson(res, 200, {
      success: true,
      data: {
        kind: data.kind || null,
        items: data.items,
        pageInfo: data.pageInfo || null,
        nextPageToken: data.nextPageToken || null,
      },
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return sendJson(res, timedOut ? 504 : 500, {
      success: false,
      error: {
        code: timedOut ? "UPSTREAM_TIMEOUT" : "INTERNAL_ERROR",
        message: timedOut
          ? "The YouTube data service timed out."
          : "The request could not be completed.",
      },
    });
  }
}
