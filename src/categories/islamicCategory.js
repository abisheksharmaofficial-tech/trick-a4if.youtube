const freezeList = (values) => Object.freeze(values);

/** Search and filtering rules for general Islamic educational content. */
export const ISLAMIC_CATEGORY_CONFIG = Object.freeze({
  id: "islamic",
  label: "Islamic",
  searchQueries: freezeList([
    "Islamic teachings Quran and Sunnah",
    "Islamic lecture Quran Hadith",
    "تعليم الإسلام القرآن والسنة",
    "ইসলামিক আলোচনা কুরআন হাদিস",
  ]),
  islamicPriorityKeywords: freezeList([
    "islam",
    "islamic",
    "muslim",
    "quran",
    "qur'an",
    "koran",
    "sunnah",
    "hadith",
    "tafsir",
    "fiqh",
    "dua",
    "salah",
    "ramadan",
    "ইসলাম",
    "ইসলামিক",
    "মুসলিম",
    "কুরআন",
    "কোরআন",
    "হাদিস",
    "সুন্নাহ",
    "তাফসির",
    "দোয়া",
    "নামাজ",
    "رمضان",
    "القرآن",
    "الإسلام",
    "حديث",
    "السنة",
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

const textFields = ["title", "description", "channelTitle", "author", "name"];
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

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
  return Number(hasKeyword(normalized, ISLAMIC_CATEGORY_CONFIG.islamicPriorityKeywords));
}

function isValidCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Keep Islamic-topic matches, exclude items with blocked title/description terms,
 * and optionally restrict results to a valid publication-date window.
 */
export function filterIslamicCategoryItems(items, options = {}) {
  try {
    if (!Array.isArray(items)) return [];

    const nowValue = options?.now instanceof Date ? options.now.getTime() : Date.now();
    if (!Number.isFinite(nowValue)) return [];

    const recencyDays = Number(options?.recencyDays);
    const cutoff = options?.recencyDays != null && Number.isFinite(recencyDays) && recencyDays >= 0
      ? nowValue - recencyDays * DAY_IN_MILLISECONDS
      : null;

    return items
      .map((item, index) => {
        if (!item || typeof item !== "object") return null;

        const searchableText = getItemText(item);
        if (!hasKeyword(searchableText, ISLAMIC_CATEGORY_CONFIG.islamicPriorityKeywords)) return null;

        const guardedText = getItemText(item, ISLAMIC_CATEGORY_CONFIG.safeContentGuard.appliesTo);
        if (ISLAMIC_CATEGORY_CONFIG.safeContentGuard.enabled
          && hasKeyword(guardedText, ISLAMIC_CATEGORY_CONFIG.safeContentGuard.blockedKeywords)) return null;

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

/** Build a search query, optionally restricted to items published after a date. */
export function buildIslamicCategoryQuery(options = {}) {
  try {
    const requestedQuery = typeof options?.query === "string" ? options.query.trim() : "";
    const baseQuery = requestedQuery || ISLAMIC_CATEGORY_CONFIG.searchQueries[0];
    const explicitDate = typeof options?.publishedAfter === "string" ? options.publishedAfter.trim() : "";
    let afterDate = isValidCalendarDate(explicitDate) ? explicitDate : "";

    if (!afterDate && options?.recencyDays != null) {
      const days = Number(options.recencyDays);
      if (Number.isFinite(days) && days >= 0) {
        const now = options?.now instanceof Date ? options.now : new Date();
        if (Number.isFinite(now.getTime())) {
          const cutoff = new Date(now.getTime() - days * DAY_IN_MILLISECONDS);
          afterDate = cutoff.toISOString().slice(0, 10);
        }
      }
    }

    return afterDate ? `${baseQuery} after:${afterDate}` : baseQuery;
  } catch {
    return ISLAMIC_CATEGORY_CONFIG.searchQueries[0];
  }
}

export default Object.freeze({
  ISLAMIC_CATEGORY_CONFIG,
  filterIslamicCategoryItems,
  buildIslamicCategoryQuery,
});
