const freezeList = (values) => Object.freeze(values);

/** Search and filtering rules for Hindi-language Dr. Zakir Naik videos. */
export const ZAKIR_NAIK_HINDI_CONFIG = Object.freeze({
  id: "zakir-naik-hindi",
  label: "Dr. Zakir Naik (Hindi)",
  searchQueries: freezeList([
    "Dr Zakir Naik Hindi",
    "Zakir Naik Hindi lecture",
    "डॉ जाकिर नाइक हिंदी",
  ]),
  hindiPriorityKeywords: freezeList([
    "hindi",
    "हिंदी",
    "हिन्दी",
    "हिंदी में",
    "हिन्दी में",
    "जाकिर नाइक",
    "जाकिर नाईक",
    "जाकिर नायक",
  ]),
  dubbingPriorityKeywords: freezeList([
    "dubbed",
    "dubbing",
    "hindi dub",
    "dubbed in hindi",
    "हिंदी डबिंग",
    "हिंदी में डब",
    "हिन्दी डबिंग",
    "हिन्दी में डब",
  ]),
  lecturePriorityKeywords: freezeList([
    "lecture",
    "lectures",
    "talk",
    "speech",
    "debate",
    "qa session",
    "question and answer",
    "व्याख्यान",
    "भाषण",
    "वाद-विवाद",
    "प्रश्न उत्तर",
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

const identityPattern = /\b(?:dr\.?\s*)?zakir\s+naik\b|जाकिर\s*(?:नाइक|नाईक|नायक)/iu;
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

function getPublishedDate(item) {
  const value = item?.publishedAt
    ?? item?.published_at
    ?? item?.publishedAtDate
    ?? item?.snippet?.publishedAt;
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function hasKeyword(text, keywords) {
  const normalized = normalizeText(text);
  return keywords.some((keyword) => normalized.includes(normalizeText(keyword)));
}

function getPriority(text) {
  return Number(hasKeyword(text, ZAKIR_NAIK_HINDI_CONFIG.hindiPriorityKeywords))
    + Number(hasKeyword(text, ZAKIR_NAIK_HINDI_CONFIG.dubbingPriorityKeywords))
    + Number(hasKeyword(text, ZAKIR_NAIK_HINDI_CONFIG.lecturePriorityKeywords));
}

/**
 * Keep identifiable Dr. Zakir Naik items, reject unsafe title/description text,
 * and order Hindi, dubbed, and lecture matches ahead of other qualifying items.
 */
export function filterZakirNaikHindiItems(items, options = {}) {
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
        if (!identityPattern.test(searchableText)) return null;

        const guardedText = normalizeText(getItemText(item, ["title", "description"]));
        if (hasKeyword(guardedText, ZAKIR_NAIK_HINDI_CONFIG.safeContentGuard.blockedKeywords)) return null;

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
export function buildZakirNaikHindiQuery(options = {}) {
  try {
    const requestedQuery = typeof options?.query === "string" ? options.query.trim() : "";
    const baseQuery = requestedQuery || ZAKIR_NAIK_HINDI_CONFIG.searchQueries[0];
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
    return ZAKIR_NAIK_HINDI_CONFIG.searchQueries[0];
  }
}

export default Object.freeze({
  ZAKIR_NAIK_HINDI_CONFIG,
  filterZakirNaikHindiItems,
  buildZakirNaikHindiQuery,
});
