const freezeList = (values) => Object.freeze(values);

/** Strict metadata-based rules for the 18+ Safe content filter. */
export const SAFE_FILTER_CATEGORY_CONFIG = Object.freeze({
  id: "18-plus-safe",
  label: "18+ Safe",
  mode: "strict",
  safetyRules: Object.freeze({
    requireMetadataAssessment: true,
    rejectMissingMetadata: false,
    rejectExplicitRating: true,
    rejectMatureRating: true,
    rejectAdultAudience: true,
    rejectUnsafeKeywords: true,
    rejectUnsafeMetadataFlags: true,
    inspectFields: freezeList([
      "title",
      "description",
      "category",
      "categoryName",
      "audience",
      "contentRating",
      "rating",
      "ageRating",
      "maturityRating",
      "isFamilyFriendly",
      "isMadeForKids",
      "madeForKids",
      "adult",
      "isAdult",
      "explicit",
      "isExplicit",
      "sensitive",
      "isSensitive",
      "privacyStatus",
    ]),
  }),
  safePriorityKeywords: freezeList([
    "all ages",
    "family friendly",
    "family-friendly",
    "general audience",
    "safe for work",
    "suitable for all ages",
  ]),
  blockedKeywords: freezeList([
    "18+",
    "18 plus",
    "adult only",
    "adults only",
    "age restricted",
    "age-restricted",
    "mature audience",
    "mature content",
    "explicit content",
    "sexually explicit",
    "sexual content",
    "porn",
    "pornography",
    "erotic",
    "nudity",
    "nude",
    "graphic violence",
    "extreme violence",
    "blood and gore",
    "gore",
    "torture",
    "self-harm instructions",
    "suicide instructions",
    "drug abuse",
    "illegal drug use",
  ]),
  unsafeMetadataValues: freezeList([
    "18+",
    "adult",
    "adult only",
    "adults only",
    "age restricted",
    "age-restricted",
    "explicit",
    "mature",
    "mature audience",
    "mature content",
    "nsfw",
    "restricted",
  ]),
  metadataScoring: Object.freeze({
    safeFlagWeight: 3,
    safeKeywordWeight: 1,
    blockedMetadataWeight: -100,
    blockedKeywordWeight: -100,
    missingMetadataWeight: 0,
    scoreField: "safeContentScore",
    minimumScore: 0,
    includeScore: false,
  }),
});

const TEXT_FIELDS = ["title", "description", "category", "categoryName"];
const BOOLEAN_UNSAFE_FIELDS = ["adult", "isAdult", "explicit", "isExplicit", "sensitive", "isSensitive"];
const BOOLEAN_SAFE_FIELDS = ["isFamilyFriendly", "isMadeForKids", "madeForKids"];
const RATING_FIELDS = ["contentRating", "rating", "ageRating", "maturityRating"];

function normalizeText(value) {
  return typeof value === "string" ? value.normalize("NFC").toLocaleLowerCase().trim() : "";
}

function getItemText(item) {
  return TEXT_FIELDS.map((field) => {
    const value = item?.[field] ?? item?.snippet?.[field];
    return typeof value === "string" ? value : "";
  }).join(" ").normalize("NFC");
}

function includesKeyword(text, keywords) {
  const normalized = normalizeText(text);
  return keywords.some((keyword) => normalized.includes(normalizeText(keyword)));
}

function hasUnsafeMetadata(item) {
  const rules = SAFE_FILTER_CATEGORY_CONFIG.safetyRules;

  for (const field of BOOLEAN_UNSAFE_FIELDS) {
    const value = item?.[field] ?? item?.snippet?.[field];
    if (value === true || value === 1 || normalizeText(value) === "true") return true;
  }

  for (const field of BOOLEAN_SAFE_FIELDS) {
    const value = item?.[field] ?? item?.snippet?.[field];
    if (value === false || value === 0 || normalizeText(value) === "false") return true;
  }

  for (const field of RATING_FIELDS) {
    const value = item?.[field] ?? item?.snippet?.[field];
    if (typeof value === "string" && includesKeyword(value, SAFE_FILTER_CATEGORY_CONFIG.unsafeMetadataValues)) {
      return true;
    }
  }

  const audience = item?.audience ?? item?.snippet?.audience;
  if (typeof audience === "string"
    && includesKeyword(audience, SAFE_FILTER_CATEGORY_CONFIG.unsafeMetadataValues)) return true;

  const privacyStatus = item?.privacyStatus ?? item?.snippet?.privacyStatus;
  if (typeof privacyStatus === "string"
    && includesKeyword(privacyStatus, SAFE_FILTER_CATEGORY_CONFIG.unsafeMetadataValues)) return true;

  // Require a defined rules reference to keep metadata evaluation explicit and fail-safe.
  return rules.requireMetadataAssessment !== true;
}

function scoreSafeMetadata(item, text) {
  const scoring = SAFE_FILTER_CATEGORY_CONFIG.metadataScoring;
  let score = 0;

  for (const field of BOOLEAN_SAFE_FIELDS) {
    const value = item?.[field] ?? item?.snippet?.[field];
    if (value === true || value === 1 || normalizeText(value) === "true") score += scoring.safeFlagWeight;
  }

  if (includesKeyword(text, SAFE_FILTER_CATEGORY_CONFIG.safePriorityKeywords)) {
    score += scoring.safeKeywordWeight;
  }

  if (hasUnsafeMetadata(item)) score += scoring.blockedMetadataWeight;
  if (includesKeyword(text, SAFE_FILTER_CATEGORY_CONFIG.blockedKeywords)) score += scoring.blockedKeywordWeight;
  return score;
}

/**
 * Evaluate an item's available metadata conservatively. Explicitly unsafe
 * ratings, flags, audience labels, and blocked title/description terms fail closed.
 * Missing optional metadata is not, on its own, treated as proof of unsafe content.
 */
export function isSafeContentItem(item, options = {}) {
  try {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;

    const rules = SAFE_FILTER_CATEGORY_CONFIG.safetyRules;
    const text = getItemText(item);
    if (rules.rejectUnsafeKeywords && includesKeyword(text, SAFE_FILTER_CATEGORY_CONFIG.blockedKeywords)) return false;
    if (rules.rejectUnsafeMetadataFlags && hasUnsafeMetadata(item)) return false;

    const score = scoreSafeMetadata(item, text);
    const suppliedScore = item?.[SAFE_FILTER_CATEGORY_CONFIG.metadataScoring.scoreField];
    const scoreValue = typeof suppliedScore === "number" && Number.isFinite(suppliedScore)
      ? suppliedScore
      : score;
    const minimumScore = typeof options?.minimumScore === "number" && Number.isFinite(options.minimumScore)
      ? options.minimumScore
      : SAFE_FILTER_CATEGORY_CONFIG.metadataScoring.minimumScore;

    return scoreValue >= minimumScore;
  } catch {
    return false;
  }
}

/** Filter a list to items that pass the strict 18+ Safe metadata evaluation. */
export function filterSafeCategoryItems(items, options = {}) {
  try {
    if (!Array.isArray(items)) return [];

    const scoredItems = items
      .map((item, index) => {
        if (!isSafeContentItem(item, options)) return null;
        const score = scoreSafeMetadata(item, getItemText(item));
        return { item, index, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.index - b.index);

    if (options?.includeScores === true) {
      return scoredItems.map(({ item, score }) => ({
        item,
        safeContentScore: score,
      }));
    }

    return scoredItems.map(({ item }) => item);
  } catch {
    return [];
  }
}

export default Object.freeze({
  SAFE_FILTER_CATEGORY_CONFIG,
  isSafeContentItem,
  filterSafeCategoryItems,
});
