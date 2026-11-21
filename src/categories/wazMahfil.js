const freezeList = (values) => Object.freeze(values);

/** Search and filtering rules for Bangla waz and mahfil videos. */
export const WAZ_MAHFIL_CONFIG = Object.freeze({
  id: "waz-mahfil",
  label: "Waz Mahfil",
  searchQueries: freezeList([
    "Bangla waz mahfil",
    "বাংলা ওয়াজ মাহফিল",
    "বাংলা ওয়াজ",
  ]),
  banglaWazPriorityKeywords: freezeList([
    "bangla waz",
    "bengali waz",
    "waz bangla",
    "ওয়াজ",
    "ওয়াজ",
    "ওয়াজ মাহফিল",
    "ওয়াজ মাহফিল",
    "বাংলা ওয়াজ",
    "বাংলা ওয়াজ",
  ]),
  banglaMahfilPriorityKeywords: freezeList([
    "bangla mahfil",
    "bengali mahfil",
    "mahfil bangla",
    "mahfil",
    "মাহফিল",
    "ইসলামী মাহফিল",
    "ওয়াজ মাহফিল",
    "ওয়াজ মাহফিল",
  ]),
  recencyFilter: Object.freeze({
    supported: true,
    option: "recencyDays",
    queryOperator: "after:",
    dateField: "publishedAt",
  }),
  safeContentGuard: Object.freeze({
    enabled: true,
    blockedKeywords: freezeList([
      "graphic violence",
      "explicit sexual content",
      "sexual exploitation",
      "self-harm instructions",
      "suicide instructions",
    ]),
    appliesTo: freezeList(["title", "description"]),
  }),
});

const topicKeywords = freezeList([
  ...WAZ_MAHFIL_CONFIG.banglaWazPriorityKeywords,
  ...WAZ_MAHFIL_CONFIG.banglaMahfilPriorityKeywords,
]);
const textFields = ["title", "description", "channelTitle", "author", "name"];

function normalizeText(value) {
  return typeof value === "string" ? value.normalize("NFC").toLocaleLowerCase() : "";
}

function getItemText(item, fields = textFields) {
  return fields.map((field) => {
    const value = item?.[field] ?? item?.snippet?.[field];
    return typeof value === "string" ? value : "";
  }).join(" ").normalize("NFC");
}

function hasKeyword(text, keywords) {
  const normalized = normalizeText(text);
  return keywords.some((keyword) => normalized.includes(normalizeText(keyword)));
}

function getPublishedDate(item) {
  const value = item?.publishedAt
    ?? item?.published_at
    ?? item?.publishedAtDate
    ?? item?.snippet?.publishedAt;
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getPriority(text) {
  const normalized = normalizeText(text);
  const hasBangla = /বাংলা|bangla|bengali/iu.test(normalized);
  const hasWaz = hasKeyword(normalized, WAZ_MAHFIL_CONFIG.banglaWazPriorityKeywords);
  const hasMahfil = hasKeyword(normalized, WAZ_MAHFIL_CONFIG.banglaMahfilPriorityKeywords);
  return Number(hasBangla) + Number(hasWaz) + Number(hasMahfil);
}

/**
 * Keep waz/mahfil matches, exclude items with blocked title/description terms,
 * and order Bangla-specific and more recent matches first.
 */
export function filterWazMahfilItems(items, options = {}) {
  try {
    if (!Array.isArray(items)) return [];

    const nowValue = options?.now instanceof Date ? options.now.getTime() : Date.now();
    if (!Number.isFinite(nowValue)) return [];
    const recencyDays = Number(options?.recencyDays);
    const cutoff = options?.recencyDays != null && Number.isFinite(recencyDays) && recencyDays >= 0
      ? nowValue - recencyDays * 24 * 60 * 60 * 1000
      : null;

    return items
      .map((item, index) => {
        if (!item || typeof item !== "object") return null;
        const searchableText = getItemText(item);
        if (!hasKeyword(searchableText, topicKeywords)) return null;

        const guardedText = normalizeText(getItemText(item, ["title", "description"]));
        if (WAZ_MAHFIL_CONFIG.safeContentGuard.enabled
          && hasKeyword(guardedText, WAZ_MAHFIL_CONFIG.safeContentGuard.blockedKeywords)) return null;

        const publishedAt = getPublishedDate(item);
        if (cutoff !== null && (publishedAt === null || publishedAt < cutoff || publishedAt > nowValue)) return null;

        return { item, index, priority: getPriority(searchableText), publishedAt: publishedAt ?? 0 };
      })
      .filter(Boolean)
      .sort((a, b) => b.priority - a.priority || b.publishedAt - a.publishedAt || a.index - b.index)
      .map(({ item }) => item);
  } catch {
    return [];
  }
}

/** Build a YouTube-compatible search query, optionally restricted to recent items. */
export function buildWazMahfilQuery(options = {}) {
  try {
    const requestedQuery = typeof options?.query === "string" ? options.query.trim() : "";
    const baseQuery = requestedQuery || WAZ_MAHFIL_CONFIG.searchQueries[0];
    const explicitDate = typeof options?.publishedAfter === "string" ? options.publishedAfter.trim() : "";
    let afterDate = /^\d{4}-\d{2}-\d{2}$/.test(explicitDate) ? explicitDate : "";

    if (!afterDate && options?.recencyDays != null) {
      const days = Number(options.recencyDays);
      if (Number.isFinite(days) && days >= 0) {
        const now = options?.now instanceof Date ? options.now : new Date();
        if (Number.isFinite(now.getTime())) {
          const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
          afterDate = cutoff.toISOString().slice(0, 10);
        }
      }
    }

    return afterDate ? `${baseQuery} after:${afterDate}` : baseQuery;
  } catch {
    return WAZ_MAHFIL_CONFIG.searchQueries[0];
  }
}

export default Object.freeze({
  WAZ_MAHFIL_CONFIG,
  filterWazMahfilItems,
  buildWazMahfilQuery,
});
