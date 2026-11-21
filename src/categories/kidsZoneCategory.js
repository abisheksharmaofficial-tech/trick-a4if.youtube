const freezeList = (values) => Object.freeze(values);

/** Search, ranking, recency, and strict safety rules for Kids Zone content. */
export const KIDS_ZONE_CATEGORY_CONFIG = Object.freeze({
  id: "kids-zone",
  label: "Kids Zone",
  searchQueries: freezeList([
    "kids educational videos stories animation",
    "children learning science and nature",
    "kids bedtime stories and animated stories",
    "শিশুদের শিক্ষামূলক গল্প ও কার্টুন",
  ]),
  kidFriendlyPriorityKeywords: freezeList([
    "kids learning",
    "kids educational",
    "educational for kids",
    "children's learning",
    "preschool learning",
    "kindergarten learning",
    "early learning",
    "learn colors",
    "learn numbers",
    "learn abc",
    "alphabet for kids",
    "phonics for kids",
    "science for kids",
    "math for kids",
    "nature for kids",
    "animal facts for kids",
    "children's story",
    "kids story",
    "bedtime story for kids",
    "fairy tale for kids",
    "moral story for kids",
    "kids animation",
    "cartoon for kids",
    "animated story for kids",
    "শিশুদের শিক্ষা",
    "শিশুদের শিক্ষামূলক",
    "শিশুদের গল্প",
    "শিশুদের কার্টুন",
    "শিশুদের অ্যানিমেশন",
    "শিশুদের বিজ্ঞান",
    "রূপকথার গল্প",
  ]),
  recencyFilter: Object.freeze({
    supported: true,
    option: "recencyDays",
    queryOperator: "after:",
    dateField: "publishedAt",
  }),
  safeContentGuard: Object.freeze({
    enabled: true,
    strict: true,
    blockedKeywords: freezeList([
      "adult content",
      "adult only",
      "18+",
      "nsfw",
      "porn",
      "pornography",
      "sexually explicit",
      "sexual content",
      "sexual activity",
      "sexualized",
      "nudity",
      "nude",
      "fetish",
      "grooming",
      "child abuse",
      "child exploitation",
      "graphic violence",
      "extreme violence",
      "violent fight",
      "blood and gore",
      "gore",
      "torture",
      "weapon tutorial",
      "how to make a weapon",
      "self-harm",
      "suicide",
      "eating disorder",
      "drug use",
      "illegal drugs",
      "drugs for kids",
      "alcohol abuse",
      "smoking",
      "vaping",
      "dangerous challenge",
      "choking challenge",
      "prank that hurts",
      "horror for adults",
      "graphic horror",
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
  return KIDS_ZONE_CATEGORY_CONFIG.kidFriendlyPriorityKeywords.reduce(
    (score, keyword) => score + Number(normalized.includes(normalizeText(keyword))),
    0,
  );
}

function isValidCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Retain only Kids Zone topic matches that pass the strict title/description
 * safety guard, and optionally require a valid publication date in the window.
 * Invalid input or an unexpected parsing error safely returns an empty list.
 */
export function filterKidsZoneCategoryItems(items, options = {}) {
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
        if (!hasKeyword(searchableText, KIDS_ZONE_CATEGORY_CONFIG.kidFriendlyPriorityKeywords)) return null;

        const guardedText = getItemText(item, KIDS_ZONE_CATEGORY_CONFIG.safeContentGuard.appliesTo);
        if (KIDS_ZONE_CATEGORY_CONFIG.safeContentGuard.enabled
          && hasKeyword(guardedText, KIDS_ZONE_CATEGORY_CONFIG.safeContentGuard.blockedKeywords)) return null;

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

/** Build a Kids Zone search query, optionally restricted to recent publications. */
export function buildKidsZoneCategoryQuery(options = {}) {
  try {
    const requestedQuery = typeof options?.query === "string" ? options.query.trim() : "";
    const baseQuery = requestedQuery || KIDS_ZONE_CATEGORY_CONFIG.searchQueries[0];
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
    return KIDS_ZONE_CATEGORY_CONFIG.searchQueries[0];
  }
}

export default Object.freeze({
  KIDS_ZONE_CATEGORY_CONFIG,
  filterKidsZoneCategoryItems,
  buildKidsZoneCategoryQuery,
});
