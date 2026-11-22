import React, { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark, BookOpen, Check, Clock3, Copy, Download, Film, History, KeyRound, ListVideo,
  Lock, Moon, Pause, Play, Plus, Search, Settings2, ShieldCheck, Sparkles, Sun, Tv2,
  Upload, Volume2, X,
} from "lucide-react";
import {
  initAnonymousCloudSync,
  subscribeSavedVideos,
  toggleSaveVideoToCloud,
  subscribeSubscriptions,
  toggleChannelSubscription,
  subscribeWatchHistory,
  recordWatchHistory,
  trackAppEvent,
} from "./firebase.js";
import { applyThemeToDocument } from "./themes/themeEngine.js";
import { ISLAMIC_CATEGORY_CONFIG, filterIslamicCategoryItems } from "./categories/islamicCategory.js";
import { KIDS_ZONE_CATEGORY_CONFIG, filterKidsZoneCategoryItems } from "./categories/kidsZoneCategory.js";
import { SAFE_FILTER_CATEGORY_CONFIG, filterSafeCategoryItems } from "./categories/safeFilterCategory.js";
import { WAZ_MAHFIL_CONFIG, filterWazMahfilItems } from "./categories/wazMahfil.js";
import { ZAKIR_NAIK_BANGLA_CONFIG, filterZakirNaikBanglaItems } from "./categories/zakirNaikBangla.js";
import { ZAKIR_NAIK_HINDI_CONFIG, filterZakirNaikHindiItems } from "./categories/zakirNaikHindi.js";
import { FeatureRegistryHub } from "./features/featureRegistryHub.js";
import { ApplicationIntegrationHub } from "./features/applicationIntegrationHub.js";
import { ErrorBoundaryTelemetry } from "./features/errorBoundaryTelemetry.js";
import { SearchFilterEngine } from "./features/searchFilterEngine.js";
import { WatchHistoryManager } from "./features/watchHistoryManager.js";
import { PlaylistCollectionManager } from "./features/playlistCollectionManager.js";
import { UserPreferenceProfileManager } from "./features/userPreferenceProfileManager.js";
import { ContentFilterSafetyGuard } from "./features/contentFilterSafetyGuard.js";
import { VideoChapterManager } from "./features/videoChapterManager.js";
import { BookmarkTimestampManager } from "./features/bookmarkTimestampManager.js";
import { SleepTimerController } from "./features/sleepTimerController.js";
import { MiniFeedNotificationManager } from "./features/miniFeedNotificationManager.js";

const STUDIO_STORAGE_KEY = "trick-a4if-tube:studio-workspace:v1";
const WORKFLOW_STAGES = Object.freeze(["Idea", "Script Ready", "Video Ready", "Scheduled", "Published"]);
const PRIME_TIME_SLOTS = Object.freeze([
  { id: "us-morning", label: "USA Morning Peak (9:00 AM EST)", bdTime: "8:00 PM BDT", note: "Good for daily discovery & kids/pets" },
  { id: "us-evening", label: "USA Evening Peak (7:00 PM EST)", bdTime: "6:00 AM BDT", note: "High watch-time & Shorts engagement" },
  { id: "uk-evening", label: "UK Evening Peak (7:00 PM GMT)", bdTime: "1:00 AM BDT", note: "Strong European/UK retention slot" },
]);

const CATEGORIES = Object.freeze([
  { id: "all", label: "All" },
  { ...ISLAMIC_CATEGORY_CONFIG, filter: filterIslamicCategoryItems },
  { ...KIDS_ZONE_CATEGORY_CONFIG, filter: filterKidsZoneCategoryItems },
  { ...SAFE_FILTER_CATEGORY_CONFIG, filter: filterSafeCategoryItems },
  { ...WAZ_MAHFIL_CONFIG, filter: filterWazMahfilItems },
  { ...ZAKIR_NAIK_BANGLA_CONFIG, filter: filterZakirNaikBanglaItems },
  { ...ZAKIR_NAIK_HINDI_CONFIG, filter: filterZakirNaikHindiItems },
]);

const VIEW_ITEMS = Object.freeze([
  ["home", "Discover", Film],
  ["dashboard", "Dashboard", Sparkles],
  ["studio", "AI & Queue", Upload],
  ["spy", "Spy & Brand", Search],
  ["engagement", "Engagement", KeyRound],
  ["saved", "Saved", Bookmark],
  ["subscriptions", "Subscriptions", Tv2],
  ["history", "History", History],
  ["playlists", "Playlists", ListVideo],
  ["bookmarks", "Bookmarks", Clock3],
  ["chapters", "Chapters", BookOpen],
  ["sleep", "Sleep timer", Moon],
  ["safety", "Safety", ShieldCheck],
  ["preferences", "Preferences", Settings2],
  ["telemetry", "Telemetry", History],
]);

function isRecord(value) {
  try { return value !== null && typeof value === "object" && !Array.isArray(value); }
  catch { return false; }
}

function text(value, fallback = "") {
  try { return typeof value === "string" || typeof value === "number" ? String(value).trim() : fallback; }
  catch { return fallback; }
}

function videoId(video) {
  return text(video?.id ?? video?.videoId ?? video?.key);
}

function videoTitle(video) {
  return text(video?.title ?? video?.name, "Untitled video");
}

function videoChannel(video) {
  return text(video?.channelName ?? video?.channelTitle ?? video?.channel ?? video?.author, "");
}

function mediaUrl(video) {
  return text(video?.url ?? video?.videoUrl ?? video?.src ?? video?.playbackUrl, "");
}

function thumbnailUrl(video) {
  return text(video?.thumbnail ?? video?.thumbnailUrl ?? video?.image, "");
}

function safeDate(value) {
  try {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
  } catch { return ""; }
}

function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const total = Math.floor(value);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function getThemeMode(preference) {
  if (preference === "light" || preference === "dark") return preference;
  try { return globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark"; }
  catch { return "dark"; }
}

function buildTitles(topic, formatMode) {
  const clean = text(topic, "Viral Story");
  const isShort = formatMode === "shorts";
  if (isShort) {
    return [
      `${clean} — Watch Till The End! #shorts`,
      `Nobody Expected This About ${clean} 😱`,
      `3 Seconds Into ${clean} & You Won't Blink`,
      `Why Everyone Is Talking About ${clean} Right Now`,
      `Wait For The Twist In ${clean} 👀`,
    ];
  }
  return [
    `${clean}: Complete Breakdown, Tips & What Actually Works`,
    `I Tested ${clean} — Here Are The Honest Results`,
    `Stop Making This Mistake With ${clean} (Full Guide)`,
    `${clean} Explained Simply For Beginners & Creators`,
    `Everything You Need To Know About ${clean} in 2026`,
  ];
}

function buildDescription(topic, keywordsText, branding) {
  const clean = text(topic, "Featured Episode");
  const tags = keywordsText.split(",").map((t) => text(t)).filter(Boolean);
  const hashtags = tags.slice(0, 6).map((t) => `#${t.replace(/[^a-zA-Z0-9_]/g, "")}`).filter((h) => h.length > 1).join(" ");
  return [
    `${clean}`,
    "",
    "Timestamps:",
    "00:00 Hook & Intro",
    "00:15 Main Breakdown",
    "01:00 Key Takeaways & Summary",
    "",
    branding.footer || "Thanks for watching TRICK A4IF TUBE.",
    hashtags ? `\n${hashtags}` : "",
    branding.disclaimer ? `\nDisclaimer: ${branding.disclaimer}` : "",
    branding.watermark ? `Credit / Watermark: ${branding.watermark}` : "",
  ].join("\n").trim();
}

function buildScriptAndPrompts(topic, formatMode, branding) {
  const clean = text(topic, "Emotional Story");
  const isShort = formatMode === "shorts";
  const wm = branding.watermark ? ` Hardcode subtle credit '${branding.watermark}' at bottom-right.` : "";
  return {
    script: [
      `[HOOK - 0:00–0:03] Stop scrolling—${clean} just changed everything in seconds.`,
      `[BODY] Walk through the key moment of ${clean} with clear pacing, emotion, and visual payoff (${isShort ? "vertical 9:16 35-55s" : "widescreen 16:9 structured"}).`,
      `[CTA] ${branding.cta || "Subscribe for more daily uploads and drop your thoughts in the comments."}`,
    ].join("\n"),
    prompts: [
      `Scene 1 (Hook, 9:16 vertical): Cinematic expressive opening shot for "${clean}", natural lighting, crisp depth of field, high retention framing.${wm}`,
      `Scene 2 (Story beat): Detailed visual sequence showing "${clean}" progression, realistic textures, smooth camera motion, zero watermarks.${wm}`,
      `Scene 3 (Payoff / CTA): Warm resolving closing frame for "${clean}", clean composition with space for caption callout.${wm}`,
    ],
  };
}

export class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error: error instanceof Error ? error : new Error("The application could not be rendered.") };
  }

  componentDidCatch(error, info) {
    try {
      this.props.telemetry?.capture(error, {
        source: "AppErrorBoundary",
        context: { componentStack: text(info?.componentStack).slice(0, 8000) },
      });
    } catch { /* Fallback UI must stay resilient. */ }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="page-content" role="alert">
        <section className="error-state">
          <h1>Something went wrong</h1>
          <p>The application encountered an error. Your local data has not been cleared.</p>
          <button type="button" className="primary" onClick={() => this.setState({ error: null })}>Try again</button>
        </section>
      </main>
    );
  }
}

function VideoCard({ video, saved, onSelect, onSave }) {
  const id = videoId(video);
  return (
    <article className="video-card">
      <button type="button" className="video-card__thumbnail" aria-label={`Play ${videoTitle(video)}`} onClick={() => onSelect(video)}>
        {thumbnailUrl(video) ? <img src={thumbnailUrl(video)} alt="" loading="lazy" /> : <span aria-hidden="true"><Film size={28} /></span>}
        {Number(video?.durationSeconds ?? video?.duration) > 0 && <span className="video-duration">{formatTime(video.durationSeconds ?? video.duration)}</span>}
      </button>
      <div className="video-card__body">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 className="video-card__title"><button type="button" onClick={() => onSelect(video)}>{videoTitle(video)}</button></h3>
          <div className="video-card__meta">{videoChannel(video)}{video.views ? ` · ${text(video.views)} views` : ""}</div>
        </div>
        {id && <button className="icon-button" type="button" aria-label={saved ? "Remove from saved videos" : "Save video"} aria-pressed={saved} onClick={() => onSave(video)}><Bookmark size={18} fill={saved ? "currentColor" : "none"} /></button>}
      </div>
    </article>
  );
}

function EmptyState({ children }) {
  return <div className="empty-state" role="status">{children}</div>;
}

function loadStudioState() {
  const defaults = {
    activeChannel: "TRICK A4IF Official",
    channels: ["TRICK A4IF Official", "Little Heartbeats (US)", "Tiny Wonders"],
    queue: [
      { id: "q-1", title: "Tiny Wonders Morning Moment", stage: "Script Ready", slot: "USA Evening Peak (7:00 PM EST)", topic: "Cute baby & puppy morning bond", format: "shorts", abTitles: ["Tiny Wonders Morning Moment #shorts", "Wait For The Puppy Reaction 🥺"] },
    ],
    activityLog: [
      { id: "log-1", time: new Date().toISOString(), task: "Workspace initialized", status: "Success" },
    ],
    branding: {
      footer: "Powered by TRICK A4IF · Subscribe for daily videos",
      disclaimer: "Educational & entertainment content. Results may vary.",
      watermark: "Tiny Wonders",
      cta: "Subscribe & turn on notifications for more!",
    },
    replyTemplates: [
      "Thank you so much for watching and supporting!",
      "Glad you enjoyed this one — more coming soon!",
      "Which part was your favorite? Let us know below!",
    ],
    blockedKeywords: ["spam", "free sub", "dm me", "telegram"],
    apiKeys: { youtubeDataApiKey: "", aiApiKey: "", webhookUrl: "" },
    pinLock: { enabled: false, pin: "" },
  };
  try {
    const raw = globalThis.localStorage?.getItem(STUDIO_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return defaults;
    return {
      ...defaults,
      ...parsed,
      channels: Array.isArray(parsed.channels) && parsed.channels.length ? parsed.channels : defaults.channels,
      queue: Array.isArray(parsed.queue) ? parsed.queue : defaults.queue,
      activityLog: Array.isArray(parsed.activityLog) ? parsed.activityLog : defaults.activityLog,
      branding: isRecord(parsed.branding) ? { ...defaults.branding, ...parsed.branding } : defaults.branding,
      replyTemplates: Array.isArray(parsed.replyTemplates) ? parsed.replyTemplates : defaults.replyTemplates,
      blockedKeywords: Array.isArray(parsed.blockedKeywords) ? parsed.blockedKeywords : defaults.blockedKeywords,
      apiKeys: isRecord(parsed.apiKeys) ? { ...defaults.apiKeys, ...parsed.apiKeys } : defaults.apiKeys,
      pinLock: isRecord(parsed.pinLock) ? { ...defaults.pinLock, ...parsed.pinLock } : defaults.pinLock,
    };
  } catch { return defaults; }
}

function AppContents({ videos: suppliedVideos }) {
  const videoElement = useRef(null);
  const managerRef = useRef(null);
  const selectedVideoRef = useRef(null);
  const unsubscribeRef = useRef([]);
  const [managers, setManagers] = useState(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [view, setView] = useState("home");
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [saved, setSaved] = useState({});
  const [subscriptions, setSubscriptions] = useState({});
  const [cloudHistory, setCloudHistory] = useState([]);
  const [history, setHistory] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [bookmarks, setBookmarks] = useState([]);
  const [chapters, setChapters] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [timerState, setTimerState] = useState(null);
  const [preferenceState, setPreferenceState] = useState(null);
  const [safetyMode, setSafetyMode] = useState("safety");
  const [errors, setErrors] = useState([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [timerMinutes, setTimerMinutes] = useState("30");
  const [playlistName, setPlaylistName] = useState("");

  const [studio, setStudio] = useState(() => loadStudioState());
  const [unlocked, setUnlocked] = useState(() => !loadStudioState().pinLock?.enabled);
  const [pinInput, setPinInput] = useState("");
  const [topicInput, setTopicInput] = useState("");
  const [formatMode, setFormatMode] = useState("shorts");
  const [keywordsInput, setKeywordsInput] = useState("shorts, viral, trending, story, tips");
  const [generatedTitles, setGeneratedTitles] = useState([]);
  const [generatedDescription, setGeneratedDescription] = useState("");
  const [generatedBundle, setGeneratedBundle] = useState({ script: "", prompts: [] });
  const [queueTitleInput, setQueueTitleInput] = useState("");
  const [queueSlotInput, setQueueSlotInput] = useState(PRIME_TIME_SLOTS[1].label);
  const [spyUrlInput, setSpyUrlInput] = useState("");
  const [spyNicheInput, setSpyNicheInput] = useState("Pets & Babies");
  const [newChannelInput, setNewChannelInput] = useState("");
  const [newTemplateInput, setNewTemplateInput] = useState("");
  const [newKeywordInput, setNewKeywordInput] = useState("");
  const [commentTestInput, setCommentTestInput] = useState("");
  const [pinnedTopicInput, setPinnedTopicInput] = useState("");
  const [generatedPinnedComment, setGeneratedPinnedComment] = useState("");

  useEffect(() => { selectedVideoRef.current = selectedVideo; }, [selectedVideo]);

  useEffect(() => {
    try { globalThis.localStorage?.setItem(STUDIO_STORAGE_KEY, JSON.stringify(studio)); }
    catch { /* Ignore storage quota/permission errors. */ }
  }, [studio]);

  const appendLog = useCallback((task, status = "Success") => {
    setStudio((prev) => ({
      ...prev,
      activityLog: [{ id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, time: new Date().toLocaleTimeString(), task, status }, ...prev.activityLog].slice(0, 40),
    }));
  }, []);

  const copyText = useCallback(async (content, label = "Copied") => {
    try {
      if (!content) return;
      if (globalThis.navigator?.clipboard?.writeText) await globalThis.navigator.clipboard.writeText(content);
      setStatusMessage(`${label} copied.`);
    } catch { setStatusMessage("Could not copy automatically; select and copy manually."); }
  }, []);

  useEffect(() => {
    let mounted = true;
    const unsubscribers = [];
    let created;
    try {
      const reportError = (error, instance) => {
        try { instance?.capture?.(error, { source: "feature-manager" }); } catch { /* Avoid cascading errors. */ }
      };
      const telemetry = new ErrorBoundaryTelemetry({ maxErrors: 250 });
      const search = new SearchFilterEngine({ historyLimit: 50, onError: (error) => reportError(error, telemetry) });
      const watchHistory = new WatchHistoryManager({ maxItems: 500, onChange: () => { if (mounted) setHistory([...watchHistory.getHistory()]); }, onError: (error) => reportError(error, telemetry) });
      const playlistManager = new PlaylistCollectionManager({ onChange: () => { if (mounted) setPlaylists([...playlistManager.getPlaylists()]); }, onError: (error) => reportError(error, telemetry) });
      const preferences = new UserPreferenceProfileManager({ onChange: () => { if (mounted) setPreferenceState(preferences.getPreferences()); }, onError: (error) => reportError(error, telemetry) });
      const safety = new ContentFilterSafetyGuard({ mode: "safety", onChange: () => { if (mounted) setSafetyMode(safety.mode); }, onError: (error) => reportError(error, telemetry) });
      const chapterManager = new VideoChapterManager({
        onChange: () => {
          const activeId = videoId(selectedVideoRef.current);
          if (mounted && activeId) setChapters([...chapterManager.getChapters(activeId)]);
        },
        onError: (error) => reportError(error, telemetry),
      });
      const bookmarkManager = new BookmarkTimestampManager({ onChange: () => { if (mounted) setBookmarks([...bookmarkManager.getBookmarks()]); }, onError: (error) => reportError(error, telemetry) });
      const sleepTimer = new SleepTimerController({ onTick: (state) => { if (mounted) setTimerState(state); }, onError: (error) => reportError(error, telemetry) });
      const miniFeed = new MiniFeedNotificationManager({ onChange: () => { if (mounted) setNotifications([...miniFeed.getNotifications()]); }, onError: (error) => reportError(error, telemetry) });
      const registry = new FeatureRegistryHub();
      const integrationHub = new ApplicationIntegrationHub({ registry });
      const modules = { telemetry, search, watchHistory, playlistManager, preferences, safety, chapterManager, bookmarkManager, sleepTimer, miniFeed };
      Object.entries(modules).forEach(([name, instance]) => registry.register({ name, instance }, { silent: true }));
      created = { ...modules, registry, integrationHub };
      managerRef.current = created;

      unsubscribers.push(
        watchHistory.subscribe(() => { if (mounted) setHistory([...watchHistory.getHistory()]); }),
        playlistManager.subscribe(() => { if (mounted) setPlaylists([...playlistManager.getPlaylists()]); }),
        bookmarkManager.subscribe(() => { if (mounted) setBookmarks([...bookmarkManager.getBookmarks()]); }),
        chapterManager.subscribe(() => {
          const activeId = videoId(selectedVideoRef.current);
          if (mounted && activeId) setChapters([...chapterManager.getChapters(activeId)]);
          else if (mounted) setChapters([]);
        }),
        sleepTimer.subscribe((state) => { if (mounted) setTimerState(state); }),
        miniFeed.subscribe(() => { if (mounted) setNotifications([...miniFeed.getNotifications()]); }),
        telemetry.subscribe(() => { if (mounted) setErrors([...telemetry.getErrors()]); }),
        preferences.subscribe(() => { if (mounted) setPreferenceState(preferences.getPreferences()); }),
      );
      unsubscribers.push(
        subscribeSavedVideos((value) => { if (mounted && isRecord(value)) setSaved(value); }),
        subscribeSubscriptions((value) => { if (mounted && isRecord(value)) setSubscriptions(value); }),
        subscribeWatchHistory((value) => { if (mounted && Array.isArray(value)) setCloudHistory(value); }),
      );
      setManagers(created);
      setHistory([...watchHistory.getHistory()]);
      setPlaylists([...playlistManager.getPlaylists()]);
      setBookmarks([...bookmarkManager.getBookmarks()]);
      setPreferenceState(preferences.getPreferences());
      setSafetyMode(safety.mode);
      setErrors([...telemetry.getErrors()]);
      setNotifications([...miniFeed.getNotifications()]);
      void initAnonymousCloudSync().catch(() => {});
    } catch (error) {
      try { created?.telemetry?.capture(error, { source: "App initialization" }); } catch { /* Keep app startup safe. */ }
      setStatusMessage("Some app features could not be initialized.");
    }

    unsubscribeRef.current = unsubscribers;
    return () => {
      mounted = false;
      unsubscribeRef.current.splice(0).forEach((unsubscribe) => {
        try { if (typeof unsubscribe === "function") unsubscribe(); } catch { /* Continue teardown. */ }
      });
      const activeManagers = managerRef.current;
      managerRef.current = null;
      setManagers(null);
      if (activeManagers) {
        try { activeManagers.integrationHub?.destroy?.(); } catch { /* Continue teardown. */ }
        Object.entries(activeManagers).forEach(([name, manager]) => {
          if (name === "integrationHub" || name === "registry") return;
          try { manager?.destroy?.(); } catch { /* Continue teardown. */ }
        });
        try { activeManagers.registry?.destroy?.(); } catch { /* Continue teardown. */ }
      }
    };
  }, []);

  useEffect(() => {
    if (!preferenceState) return;
    const mode = getThemeMode(preferenceState.theme);
    try { applyThemeToDocument(mode, null); } catch { /* CSS defaults remain usable. */ }
  }, [preferenceState]);

  useEffect(() => {
    if (!selectedVideo || !managers) { setChapters([]); return; }
    const id = videoId(selectedVideo);
    if (!id) { setChapters([]); return; }
    try {
      managers.chapterManager.setChapters(id, selectedVideo.chapters ?? [], { totalDuration: selectedVideo.durationSeconds ?? selectedVideo.duration });
      setChapters([...managers.chapterManager.getChapters(id)]);
    } catch (error) { managers.telemetry.capture(error, { source: "chapter selection" }); }
  }, [selectedVideo, managers]);

  const sourceVideos = useMemo(() => {
    try {
      const external = suppliedVideos ?? globalThis.__TRICK_A4IF_VIDEOS__;
      return Array.isArray(external) ? external.filter((item) => isRecord(item) && videoId(item)) : [];
    } catch { return []; }
  }, [suppliedVideos]);

  const filteredVideos = useMemo(() => {
    try {
      if (!managers) return [];
      const safe = managers.safety.filterItems(sourceVideos);
      const selectedCategory = CATEGORIES.find((item) => item.id === category);
      const categorized = selectedCategory?.filter ? selectedCategory.filter(safe) : safe;
      return [...managers.search.search(categorized, query, { sortBy: query ? "relevance" : "newest", recordHistory: false })];
    } catch (error) {
      try { managers?.telemetry?.capture(error, { source: "search and category filtering" }); } catch { /* Fail closed. */ }
      return [];
    }
  }, [sourceVideos, category, query, managers]);

  const selectVideo = useCallback((video) => {
    try {
      const id = videoId(video);
      if (!id) return;
      setSelectedVideo(video);
      setPlaybackTime(0);
      setDuration(Number(video.durationSeconds ?? video.duration) || 0);
      setPlaying(false);
      trackAppEvent("video_selected", { videoId: id });
      const manager = managerRef.current;
      manager?.watchHistory?.record(video, { position: 0, duration: Number(video.durationSeconds ?? video.duration) || 0 });
      void recordWatchHistory(video).catch(() => {});
    } catch (error) {
      try { managerRef.current?.telemetry?.capture(error, { source: "video selection" }); } catch { /* No-op. */ }
    }
  }, []);

  const toggleSave = useCallback(async (video) => {
    try {
      const id = videoId(video);
      if (!id) return;
      await toggleSaveVideoToCloud(video);
      trackAppEvent("video_save_toggled", { videoId: id });
    } catch (error) { try { managerRef.current?.telemetry?.capture(error, { source: "save video" }); } catch { /* No-op. */ } }
  }, []);

  const togglePlay = useCallback(() => {
    const element = videoElement.current;
    if (!element) return;
    try {
      if (element.paused) {
        const result = element.play();
        if (result?.catch) result.catch((error) => managerRef.current?.telemetry?.capture(error, { source: "media playback" }));
      } else element.pause();
    } catch (error) { managerRef.current?.telemetry?.capture(error, { source: "media controls" }); }
  }, []);

  const recordProgress = useCallback(() => {
    try {
      const video = selectedVideoRef.current;
      if (!video) return;
      const manager = managerRef.current;
      manager?.watchHistory?.update(video, { position: playbackTime, duration });
      void recordWatchHistory({ ...video, position: playbackTime, duration }).catch(() => {});
    } catch { /* Best-effort local history. */ }
  }, [playbackTime, duration]);

  const toggleSubscription = async (channelName, channelId) => {
    try {
      const id = text(channelId || channelName);
      if (id) await toggleChannelSubscription({ id, channelName: text(channelName) });
    } catch (error) { managers?.telemetry?.capture(error, { source: "channel subscription" }); }
  };

  const createPlaylist = (event) => {
    try {
      event.preventDefault();
      const name = playlistName.trim();
      if (!name || !managers) return;
      const playlist = managers.playlistManager.createPlaylist({ name });
      if (playlist && selectedVideo) managers.playlistManager.addItem(playlist.id, selectedVideo);
      setPlaylistName("");
    } catch (error) { try { managers?.telemetry?.capture(error, { source: "create playlist" }); } catch { /* No-op. */ } }
  };

  const addBookmark = () => {
    try {
      if (!selectedVideo || !managers) return;
      const bookmark = managers.bookmarkManager.createBookmark({
        videoId: videoId(selectedVideo), timeSeconds: playbackTime, label: `${videoTitle(selectedVideo)} · ${formatTime(playbackTime)}`,
      });
      if (bookmark) setStatusMessage(`Bookmark added at ${formatTime(playbackTime)}.`);
    } catch (error) { try { managers?.telemetry?.capture(error, { source: "add bookmark" }); } catch { /* No-op. */ } }
  };

  const addChapter = () => {
    try {
      if (!selectedVideo || !managers) return;
      const title = globalThis.prompt?.("Chapter title")?.trim();
      if (!title) return;
      managers.chapterManager.addChapter(videoId(selectedVideo), { title, startTime: playbackTime });
      setChapters([...managers.chapterManager.getChapters(videoId(selectedVideo))]);
    } catch (error) { try { managers?.telemetry?.capture(error, { source: "add chapter" }); } catch { /* No-op. */ } }
  };

  const changePreference = (key, value) => {
    try { managers?.preferences?.setPreference(key, value, { source: "user" }); }
    catch (error) { managers?.telemetry?.capture(error, { source: "preferences" }); }
  };

  const startTimer = () => {
    try {
      const minutes = Number(timerMinutes);
      if (Number.isFinite(minutes) && minutes > 0) managers?.sleepTimer?.startMinutes(minutes);
    } catch (error) { try { managers?.telemetry?.capture(error, { source: "sleep timer" }); } catch { /* No-op. */ } }
  };

  const handleGenerateContent = () => {
    const cleanTopic = text(topicInput, "Viral Short Story");
    setGeneratedTitles(buildTitles(cleanTopic, formatMode));
    setGeneratedDescription(buildDescription(cleanTopic, keywordsInput, studio.branding));
    setGeneratedBundle(buildScriptAndPrompts(cleanTopic, formatMode, studio.branding));
    appendLog(`Generated ${formatMode} titles, SEO description, script & prompts for "${cleanTopic}"`, "Success");
  };

  const handleAddQueueItem = (event) => {
    event.preventDefault();
    const title = text(queueTitleInput || topicInput);
    if (!title) return;
    const item = {
      id: `q-${Date.now()}`,
      title,
      stage: "Idea",
      slot: queueSlotInput,
      topic: title,
      format: formatMode,
      abTitles: generatedTitles.slice(0, 3),
    };
    setStudio((prev) => ({ ...prev, queue: [item, ...prev.queue] }));
    setQueueTitleInput("");
    appendLog(`Queued "${title}" (${item.stage})`, "Success");
  };

  const cycleQueueStage = (id) => {
    setStudio((prev) => ({
      ...prev,
      queue: prev.queue.map((item) => {
        if (item.id !== id) return item;
        const idx = WORKFLOW_STAGES.indexOf(item.stage);
        const nextStage = WORKFLOW_STAGES[(idx + 1) % WORKFLOW_STAGES.length];
        appendLog(`Moved "${item.title}" → ${nextStage}`, "Success");
        return { ...item, stage: nextStage };
      }),
    }));
  };

  const exportBackupJson = () => {
    try {
      const payload = JSON.stringify({ exportedAt: new Date().toISOString(), studio, playlists, bookmarks }, null, 2);
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "trick-a4if-tube-backup.json";
      a.click();
      URL.revokeObjectURL(url);
      appendLog("Exported JSON backup", "Success");
    } catch { setStatusMessage("Backup export is not available in this environment."); }
  };

  const exportQueueCsv = () => {
    try {
      const escapeCsv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const rows = ["Title,Stage,ScheduleSlot,Format", ...studio.queue.map((q) => [q.title, q.stage, q.slot, q.format].map(escapeCsv).join(","))];
      const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "trick-a4if-queue.csv";
      a.click();
      URL.revokeObjectURL(url);
      appendLog("Exported Queue CSV", "Success");
    } catch { setStatusMessage("CSV export is not available in this environment."); }
  };

  if (studio.pinLock?.enabled && !unlocked) {
    return (
      <main className="page-content">
        <section className="panel" style={{ maxWidth: 420, margin: "48px auto" }}>
          <div className="panel-heading"><h1><Lock size={18} /> App PIN Lock</h1></div>
          <p className="muted">Enter your PIN to unlock TRICK A4IF TUBE.</p>
          <form onSubmit={(e) => {
            e.preventDefault();
            if (pinInput === studio.pinLock.pin) { setUnlocked(true); setPinInput(""); setStatusMessage("App unlocked."); }
            else setStatusMessage("Incorrect PIN.");
          }} style={{ display: "flex", gap: 8 }}>
            <input type="password" value={pinInput} onChange={(e) => setPinInput(e.target.value)} placeholder="Enter PIN" required />
            <button type="submit" className="primary">Unlock</button>
          </form>
          {statusMessage && <p className="muted" style={{ marginTop: 8 }}>{statusMessage}</p>}
        </section>
      </main>
    );
  }

  const activeCategory = CATEGORIES.find((item) => item.id === category)?.label ?? "All";
  const savedVideos = Object.values(saved).filter(isRecord);
  const subscribedChannels = Object.values(subscriptions).filter(isRecord);
  const currentId = videoId(selectedVideo);
  const selectedIsSaved = Boolean(saved[currentId]);
  const activeChapter = currentId ? managers?.chapterManager?.getActiveChapter(currentId, playbackTime, { totalDuration: duration }) : null;
  const isCommentSpam = studio.blockedKeywords.some((kw) => kw && commentTestInput.toLowerCase().includes(kw.toLowerCase()));

  const renderVideoGrid = (list) => list.length ? (
    <div className="video-feed">{list.map((video) => <VideoCard key={videoId(video)} video={video} saved={Boolean(saved[videoId(video)])} onSelect={selectVideo} onSave={toggleSave} />)}</div>
  ) : <EmptyState>{sourceVideos.length ? "No videos match the current search and filters." : "Add video records through the App videos prop or window.__TRICK_A4IF_VIDEOS__ to populate your library."}</EmptyState>;

  const renderDashboard = () => (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h1>Channel & Automation Dashboard</h1>
          <p className="muted">Active channel: <strong>{studio.activeChannel}</strong> · Library videos: {sourceVideos.length} · Queue items: {studio.queue.length}</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select aria-label="Switch active channel" value={studio.activeChannel} onChange={(e) => { setStudio((p) => ({ ...p, activeChannel: e.target.value })); appendLog(`Switched channel to ${e.target.value}`, "Success"); }}>
            {studio.channels.map((ch) => <option key={ch} value={ch}>{ch}</option>)}
          </select>
          <input value={newChannelInput} onChange={(e) => setNewChannelInput(e.target.value)} placeholder="New channel name" style={{ width: 160 }} />
          <button type="button" className="secondary" onClick={() => {
            const name = text(newChannelInput);
            if (!name) return;
            setStudio((p) => ({ ...p, channels: p.channels.includes(name) ? p.channels : [...p.channels, name], activeChannel: name }));
            setNewChannelInput("");
            appendLog(`Added & switched to channel "${name}"`, "Success");
          }}><Plus size={15} /> Channel</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 16 }}>
        <div className="panel"><strong>Tracked Library</strong><div className="muted">{sourceVideos.length} videos · {savedVideos.length} saved</div></div>
        <div className="panel"><strong>Watch History</strong><div className="muted">{history.length || cloudHistory.length} recorded items</div></div>
        <div className="panel"><strong>Upload Queue</strong><div className="muted">{studio.queue.length} queued drafts</div></div>
        <div className="panel"><strong>RecentCTR / Status</strong><div className="muted">{studio.queue[0]?.stage ?? "Idle"} · Active</div></div>
      </div>

      <h2>Automation Activity Log</h2>
      {studio.activityLog.map((entry) => (
        <div className="telemetry-event" key={entry.id}>
          <span className="badge">{entry.status}</span>
          <span>{entry.task}</span>
          <span className="muted">{entry.time}</span>
        </div>
      ))}
    </section>
  );

  const renderStudio = () => (
    <section className="panel">
      <div className="panel-heading"><h1>AI Content, SEO & Upload Queue</h1></div>
      <div style={{ display: "grid", gap: 10, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input value={topicInput} onChange={(e) => setTopicInput(e.target.value)} placeholder="Enter topic (e.g., Baby & Puppy Morning Bond)" style={{ flex: 1, minWidth: 220 }} />
          <select value={formatMode} onChange={(e) => setFormatMode(e.target.value)}>
            <option value="shorts">Shorts Mode (9:16)</option>
            <option value="long">Long Video Mode (16:9)</option>
          </select>
          <button type="button" className="primary" onClick={handleGenerateContent}><Sparkles size={16} /> Generate All</button>
        </div>
        <input value={keywordsInput} onChange={(e) => setKeywordsInput(e.target.value)} placeholder="Comma-separated keywords/tags" />
      </div>

      {generatedTitles.length > 0 && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-heading"><h2>Title & A/B Suggestions</h2></div>
          {generatedTitles.map((t, i) => (
            <div className="list-row" key={`${i}-${t}`}>
              <span>{t}</span>
              <button type="button" className="secondary" onClick={() => copyText(t, "Title")}><Copy size={14} /> Copy</button>
            </div>
          ))}
        </div>
      )}

      {generatedDescription && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-heading"><h2>Auto SEO Description</h2><button type="button" className="secondary" onClick={() => copyText(generatedDescription, "Description")}><Copy size={14} /> Copy</button></div>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{generatedDescription}</pre>
        </div>
      )}

      {generatedBundle.script && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-heading"><h2>Script & Scene AI Prompts</h2><button type="button" className="secondary" onClick={() => copyText(`${generatedBundle.script}\n\n${generatedBundle.prompts.join("\n")}`, "Script & Prompts")}><Copy size={14} /> Copy All</button></div>
          <pre style={{ whiteSpace: "pre-wrap", marginBottom: 10 }}>{generatedBundle.script}</pre>
          {generatedBundle.prompts.map((pr, idx) => <p className="muted" key={idx}>{pr}</p>)}
        </div>
      )}

      <div className="panel">
        <div className="panel-heading"><h2>Upload Queue & US/UK Prime-Time Scheduler</h2></div>
        <form onSubmit={handleAddQueueItem} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <input value={queueTitleInput} onChange={(e) => setQueueTitleInput(e.target.value)} placeholder="Queue item title" />
          <select value={queueSlotInput} onChange={(e) => setQueueSlotInput(e.target.value)}>
            {PRIME_TIME_SLOTS.map((s) => <option key={s.id} value={s.label}>{s.label} — {s.bdTime}</option>)}
          </select>
          <button type="submit" className="primary"><Plus size={15} /> Add to Queue</button>
        </form>
        <p className="muted" style={{ marginBottom: 10 }}>
          {PRIME_TIME_SLOTS.map((s) => `${s.label} (${s.bdTime})`).join(" · ")}
        </p>
        {studio.queue.map((item) => (
          <div className="list-row" key={item.id}>
            <div style={{ flex: 1 }}>
              <strong>{item.title}</strong>
              <div className="muted">{item.slot} · Format: {item.format}</div>
            </div>
            <span className="badge">{item.stage}</span>
            <button type="button" className="secondary" onClick={() => cycleQueueStage(item.id)}>Next Stage</button>
            <button type="button" className="icon-button" aria-label={`Remove ${item.title}`} onClick={() => setStudio((p) => ({ ...p, queue: p.queue.filter((q) => q.id !== item.id) }))}><X size={16} /></button>
          </div>
        ))}
      </div>
    </section>
  );

  const renderSpyAndBrand = () => {
    const match = spyUrlInput.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
    const extractedId = match ? match[1] : "";
    return (
      <section className="panel">
        <div className="panel-heading"><h1>Competitor Spy, Thumbnail Preview & Branding</h1></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <input value={spyUrlInput} onChange={(e) => setSpyUrlInput(e.target.value)} placeholder="Paste YouTube video URL to inspect ID & thumbnail" style={{ flex: 1, minWidth: 220 }} />
          <input value={spyNicheInput} onChange={(e) => setSpyNicheInput(e.target.value)} placeholder="Trending niche (Pets, Babies, Tech)" />
        </div>
        {extractedId && (
          <div className="panel" style={{ marginBottom: 14 }}>
            <strong>Detected Video ID:</strong> {extractedId}
            <div className="muted">HQ Thumbnail URL: https://i.ytimg.com/vi/{extractedId}/hqdefault.jpg</div>
            <div className="muted">MaxRes Thumbnail URL: https://i.ytimg.com/vi/{extractedId}/maxresdefault.jpg</div>
          </div>
        )}
        <div className="panel" style={{ marginBottom: 14 }}>
          <h2>Feed Card Preview ({studio.activeChannel})</h2>
          <p className="muted">Title: <strong>{generatedTitles[0] || queueTitleInput || topicInput || "Sample Viral Video Title"}</strong></p>
          <p className="muted">Niche trend focus: <strong>{spyNicheInput}</strong> · Watermark: <strong>{studio.branding.watermark}</strong></p>
        </div>
        <div className="panel">
          <h2>Branding Template Saver</h2>
          <div style={{ display: "grid", gap: 8 }}>
            <input value={studio.branding.watermark} onChange={(e) => setStudio((p) => ({ ...p, branding: { ...p.branding, watermark: e.target.value } }))} placeholder="Watermark / Credit text" />
            <input value={studio.branding.footer} onChange={(e) => setStudio((p) => ({ ...p, branding: { ...p.branding, footer: e.target.value } }))} placeholder="Default description footer" />
            <input value={studio.branding.disclaimer} onChange={(e) => setStudio((p) => ({ ...p, branding: { ...p.branding, disclaimer: e.target.value } }))} placeholder="Default disclaimer" />
          </div>
        </div>
      </section>
    );
  };

  const renderEngagementAndSystem = () => (
    <section className="panel">
      <div className="panel-heading"><h1>Engagement, API Keys, Backup & PIN Lock</h1></div>
      <div className="panel" style={{ marginBottom: 14 }}>
        <h2>Quick Reply Templates & Pinned Comment</h2>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input value={newTemplateInput} onChange={(e) => setNewTemplateInput(e.target.value)} placeholder="Add quick reply template" />
          <button type="button" className="secondary" onClick={() => { if (!text(newTemplateInput)) return; setStudio((p) => ({ ...p, replyTemplates: [text(newTemplateInput), ...p.replyTemplates] })); setNewTemplateInput(""); }}>Add</button>
        </div>
        {studio.replyTemplates.map((tpl, i) => (
          <div className="list-row" key={i}><span>{tpl}</span><button type="button" className="secondary" onClick={() => copyText(tpl, "Reply template")}><Copy size={14} /> Copy</button></div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input value={pinnedTopicInput} onChange={(e) => setPinnedTopicInput(e.target.value)} placeholder="Pinned comment topic/question" />
          <button type="button" className="secondary" onClick={() => setGeneratedPinnedComment(`📌 ${text(pinnedTopicInput, "What did you think?")} Share your thoughts below & subscribe for more!`)}>Generate Pinned</button>
        </div>
        {generatedPinnedComment && <p className="muted" style={{ marginTop: 6 }}>{generatedPinnedComment}</p>}
      </div>

      <div className="panel" style={{ marginBottom: 14 }}>
        <h2>Spam & Keyword Filter Checker</h2>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input value={newKeywordInput} onChange={(e) => setNewKeywordInput(e.target.value)} placeholder="Add blocked keyword" />
          <button type="button" className="secondary" onClick={() => { if (!text(newKeywordInput)) return; setStudio((p) => ({ ...p, blockedKeywords: [...p.blockedKeywords, text(newKeywordInput).toLowerCase()] })); setNewKeywordInput(""); }}>Block Word</button>
        </div>
        <p className="muted">Blocked words: {studio.blockedKeywords.join(", ")}</p>
        <input value={commentTestInput} onChange={(e) => setCommentTestInput(e.target.value)} placeholder="Test a comment against blocked keywords..." />
        {commentTestInput && <p className="muted" style={{ marginTop: 6 }}>Status: <strong>{isCommentSpam ? "Flagged as Spam / Blocked" : "Clean Comment"}</strong></p>}
      </div>

      <div className="panel" style={{ marginBottom: 14 }}>
        <h2>Dynamic API Keys, PIN Lock & Backup/Export</h2>
        <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
          <input type="password" value={studio.apiKeys.youtubeDataApiKey} onChange={(e) => setStudio((p) => ({ ...p, apiKeys: { ...p.apiKeys, youtubeDataApiKey: e.target.value } }))} placeholder="YouTube Data API v3 Key" />
          <input type="password" value={studio.apiKeys.aiApiKey} onChange={(e) => setStudio((p) => ({ ...p, apiKeys: { ...p.apiKeys, aiApiKey: e.target.value } }))} placeholder="AI Content API Key" />
          <input value={studio.apiKeys.webhookUrl} onChange={(e) => setStudio((p) => ({ ...p, apiKeys: { ...p.apiKeys, webhookUrl: e.target.value } }))} placeholder="Automation Webhook URL" />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={studio.pinLock.enabled} onChange={(e) => { const enabled = e.target.checked; setStudio((p) => ({ ...p, pinLock: { ...p.pinLock, enabled } })); setUnlocked(!enabled || !studio.pinLock.pin); }} />
            Enable PIN Lock
          </label>
          <input type="password" value={studio.pinLock.pin} onChange={(e) => setStudio((p) => ({ ...p, pinLock: { ...p.pinLock, pin: e.target.value } }))} placeholder="Set 4+ digit PIN" style={{ width: 150 }} />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="secondary" onClick={exportBackupJson}><Download size={15} /> Export JSON</button>
          <button type="button" className="secondary" onClick={exportQueueCsv}><Download size={15} /> Export Queue CSV</button>
        </div>
      </div>
    </section>
  );

  const renderHome = () => (
    <>
      <div className="category-pills" role="group" aria-label="Filter videos by category">
        {CATEGORIES.map((item) => <button key={item.id} className="category-pill" type="button" aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.label}</button>)}
      </div>
      <div className="section-heading"><h1>{activeCategory}</h1><span className="muted">{filteredVideos.length} {filteredVideos.length === 1 ? "video" : "videos"}</span></div>
      {renderVideoGrid(filteredVideos)}
    </>
  );

  const renderSaved = () => <><div className="section-heading"><h1>Saved videos</h1></div>{renderVideoGrid(savedVideos)}</>;
  const renderSubscriptions = () => (
    <section className="panel"><div className="panel-heading"><h1>Subscriptions</h1></div>
      {subscribedChannels.length ? subscribedChannels.map((channel) => <div className="subscription-item" key={text(channel.id)}><Tv2 size={20} /><strong>{text(channel.channelName || channel.name || channel.id)}</strong><button className="secondary" type="button" onClick={() => toggleSubscription(channel.channelName, channel.id)}>Unsubscribe</button></div>) : <EmptyState>No subscribed channels yet. Subscribe from a video to keep channels here.</EmptyState>}
      {selectedVideo && videoChannel(selectedVideo) && <button className="primary" type="button" onClick={() => toggleSubscription(videoChannel(selectedVideo), selectedVideo.channelId)}>Subscribe to {videoChannel(selectedVideo)}</button>}
    </section>
  );
  const renderHistory = () => {
    const entries = history.length ? history : cloudHistory;
    return <section className="panel"><div className="panel-heading"><h1>Watch history</h1><span className="muted">{entries.length}</span></div>
      {entries.length ? entries.map((item) => <div className="history-item" key={videoId(item)}><button type="button" className="secondary" onClick={() => { const match = sourceVideos.find((video) => videoId(video) === videoId(item)); if (match) selectVideo(match); }}>{videoTitle(item)}</button><span className="muted">{text(item.channel)}</span><span className="muted">{safeDate(item.lastWatchedAt ?? item.watchedAt)}</span></div>) : <EmptyState>Videos you watch will appear here.</EmptyState>}
    </section>;
  };
  const renderPlaylists = () => (
    <section className="panel"><div className="panel-heading"><h1>Playlists</h1></div>
      <form className="toolbar" onSubmit={createPlaylist} style={{ display: "flex", gap: 8, marginBottom: 16 }}><label className="sr-only" htmlFor="playlist-name">Playlist name</label><input id="playlist-name" value={playlistName} onChange={(event) => setPlaylistName(event.target.value)} maxLength={512} required placeholder="Create a playlist" /><button className="primary" type="submit"><Plus size={16} /> Create</button></form>
      {playlists.length ? playlists.map((playlist) => <div className="playlist-item" key={playlist.id}><ListVideo size={20} /><div style={{ flex: 1 }}><strong>{playlist.name}</strong><div className="muted">{playlist.items.length} videos</div></div>{selectedVideo && <button className="secondary" type="button" onClick={() => managers?.playlistManager?.addItem(playlist.id, selectedVideo)}>Add current</button>}<button className="icon-button" aria-label={`Delete ${playlist.name}`} type="button" onClick={() => managers?.playlistManager?.deletePlaylist(playlist.id)}><X size={18} /></button></div>) : <EmptyState>Your playlists will be listed here.</EmptyState>}
    </section>
  );
  const renderBookmarks = () => (
    <section className="panel"><div className="panel-heading"><h1>Timestamp bookmarks</h1>{selectedVideo && <button className="primary" type="button" onClick={addBookmark}><Plus size={16} /> Bookmark current time</button>}</div>
      {bookmarks.length ? bookmarks.map((bookmark) => <div className="bookmark-item" key={bookmark.id}><Bookmark size={18} /><div style={{ flex: 1 }}><strong>{bookmark.label || videoTitle(sourceVideos.find((item) => videoId(item) === bookmark.videoId) || {})}</strong><div className="muted">{formatTime(bookmark.timeSeconds)} · {bookmark.videoId}</div></div><button className="secondary" type="button" onClick={() => { const video = sourceVideos.find((item) => videoId(item) === bookmark.videoId); if (video) { selectVideo(video); if (videoElement.current) videoElement.current.currentTime = bookmark.timeSeconds; } }}>Open</button><button className="icon-button" aria-label="Delete bookmark" type="button" onClick={() => managers?.bookmarkManager?.deleteBookmark(bookmark.id)}><X size={18} /></button></div>) : <EmptyState>Save a timestamp while watching to create a bookmark.</EmptyState>}
    </section>
  );
  const renderChapters = () => (
    <section className="panel"><div className="panel-heading"><div><h1>Video chapters</h1><p className="muted">{selectedVideo ? videoTitle(selectedVideo) : "Select a video to view its chapter markers."}</p></div>{selectedVideo && <button className="primary" type="button" onClick={addChapter}><Plus size={16} /> Add chapter</button>}</div>
      {chapters.length ? chapters.map((chapter) => <button className="list-row" key={chapter.id} type="button" onClick={() => { if (videoElement.current) videoElement.current.currentTime = chapter.startTime; setPlaybackTime(chapter.startTime); }}><span className="badge">{formatTime(chapter.startTime)}</span><span>{chapter.title}</span></button>) : <EmptyState>No chapter markers are available for this video.</EmptyState>}
    </section>
  );
  const renderSleep = () => (
    <section className="panel"><div className="panel-heading"><h1>Sleep timer</h1><Moon size={20} /></div>
      <p className="muted">Timer status: {timerState?.state ?? "idle"}{timerState?.state === "running" && timerState.mode === "duration" ? ` · ${Math.ceil(timerState.remainingSeconds)} seconds remaining` : ""}</p>
      <form onSubmit={(event) => { event.preventDefault(); startTimer(); }} className="toolbar" style={{ display: "flex", gap: 8, alignItems: "end" }}><label>Minutes<input type="number" min="1" max="525600" value={timerMinutes} onChange={(event) => setTimerMinutes(event.target.value)} /></label><button className="primary" type="submit"><Play size={16} /> Start</button>{timerState?.state === "running" && <button className="secondary" type="button" onClick={() => managers?.sleepTimer?.pause()}><Pause size={16} /> Pause</button>}{timerState?.state === "paused" && <button className="secondary" type="button" onClick={() => managers?.sleepTimer?.resume()}>Resume</button>}<button className="secondary" type="button" onClick={() => managers?.sleepTimer?.clear()}>Clear</button></form>
    </section>
  );
  const renderSafety = () => (
    <section className="panel"><div className="panel-heading"><h1>Content safety</h1><ShieldCheck size={20} /></div><p className="muted">Filtering evaluates metadata and caller-configured blocked terms on local video records.</p>
      <label>Filter mode<select value={safetyMode} onChange={(event) => managers?.safety?.setMode(event.target.value)}><option value="off">Off</option><option value="safety">Safety</option><option value="strict">Strict</option></select></label>
      <p className="muted">Strict mode hides unrated records. Current library: {sourceVideos.length} records; visible after safety checks: {managers?.safety?.filterItems(sourceVideos).length ?? 0}.</p>
    </section>
  );
  const renderPreferences = () => (
    <section className="panel"><div className="panel-heading"><h1>Preferences</h1><Settings2 size={20} /></div>
      {preferenceState && <div className="preferences-form">
        <label>Theme<select value={preferenceState.theme} onChange={(event) => changePreference("theme", event.target.value)}><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
        <label>Playback speed<select value={preferenceState.defaultPlaybackSpeed} onChange={(event) => changePreference("defaultPlaybackSpeed", Number(event.target.value))}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}</select></label>
        <label>Language<input value={preferenceState.language} onChange={(event) => changePreference("language", event.target.value)} maxLength={64} /></label>
        <label>Default quality<input value={preferenceState.defaultQuality} onChange={(event) => changePreference("defaultQuality", event.target.value)} maxLength={128} /></label>
        {[["autoplay", "Autoplay"], ["captionsEnabled", "Captions"], ["dataSaver", "Data saver"], ["reducedMotion", "Reduce motion"]].map(([key, label]) => <label key={key} style={{ display: "flex", alignItems: "center" }}><input type="checkbox" checked={preferenceState[key] === true} onChange={(event) => changePreference(key, event.target.checked)} />{label}</label>)}
      </div>}
    </section>
  );
  const renderTelemetry = () => (
    <section className="panel telemetry-panel"><div className="panel-heading"><div><h1>Telemetry & diagnostics</h1><p className="muted">Runtime errors are retained locally and are not displayed as sample events.</p></div><span className="badge">{errors.length} errors</span></div>
      {notifications.map((notice) => <div className="telemetry-event" key={notice.id}><span className="badge">{notice.type}</span><span>{notice.title || notice.message}</span><span className="muted">{safeDate(notice.createdAt)}</span></div>)}
      {errors.length ? errors.map((error) => <div className="telemetry-event" key={error.id || `${error.name}-${error.timestamp}`}><span className="status-badge error">{error.severity}</span><div style={{ minWidth: 0 }}><strong>{error.name}</strong><div className="muted">{error.message}</div><div className="muted">{error.source}</div></div><span className="muted">{safeDate(error.lastSeenAt)}</span></div>) : <EmptyState>No runtime errors have been recorded.</EmptyState>}
    </section>
  );

  const renderView = () => {
    switch (view) {
      case "dashboard": return renderDashboard();
      case "studio": return renderStudio();
      case "spy": return renderSpyAndBrand();
      case "engagement": return renderEngagementAndSystem();
      case "saved": return renderSaved();
      case "subscriptions": return renderSubscriptions();
      case "history": return renderHistory();
      case "playlists": return renderPlaylists();
      case "bookmarks": return renderBookmarks();
      case "chapters": return renderChapters();
      case "sleep": return renderSleep();
      case "safety": return renderSafety();
      case "preferences": return renderPreferences();
      case "telemetry": return renderTelemetry();
      default: return renderHome();
    }
  };

  const renderPlayer = () => selectedVideo && (
    <section className="player-layout" aria-label="Video player">
      <div>
        <div className="active-player">
          {mediaUrl(selectedVideo) ? <video ref={videoElement} src={mediaUrl(selectedVideo)} poster={thumbnailUrl(selectedVideo) || undefined} controls={false} playsInline preload="metadata"
            onPlay={() => { setPlaying(true); trackAppEvent("playback_started", { videoId: currentId }); }}
            onPause={() => { setPlaying(false); recordProgress(); }}
            onTimeUpdate={(event) => { setPlaybackTime(event.currentTarget.currentTime); setDuration(event.currentTarget.duration || duration); }}
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || duration)}
            onEnded={() => { setPlaying(false); recordProgress(); }}
            onError={(event) => managers?.telemetry?.capture(event.currentTarget.error || "Video playback failed", { source: "HTMLVideoElement", context: { videoId: currentId } })} />
            : <div className="empty-state" style={{ aspectRatio: "16 / 9", border: 0, borderRadius: 0 }}><Film size={34} /><span>No playable media URL is available for this record.</span></div>}
          {mediaUrl(selectedVideo) && <div className="player-control-bar">
            <button type="button" aria-label={playing ? "Pause" : "Play"} onClick={togglePlay}>{playing ? <Pause size={20} /> : <Play size={20} />}</button>
            <span className="player-time">{formatTime(playbackTime)}</span>
            <input aria-label="Seek video" type="range" min="0" max={duration || 0} step="0.1" value={Math.min(playbackTime, duration || playbackTime)} onChange={(event) => { const position = Number(event.target.value); setPlaybackTime(position); if (videoElement.current) videoElement.current.currentTime = position; }} />
            <span className="player-time">{formatTime(duration)}</span>
            <Volume2 size={18} aria-hidden="true" />
          </div>}
        </div>
        <div className="section-heading" style={{ marginTop: 16 }}><div><h1>{videoTitle(selectedVideo)}</h1><p className="muted">{videoChannel(selectedVideo)}</p></div><div className="header-actions">
          {videoChannel(selectedVideo) && <button className="secondary" type="button" onClick={() => toggleSubscription(videoChannel(selectedVideo), selectedVideo.channelId)}>{subscriptions[text(selectedVideo.channelId || videoChannel(selectedVideo))] ? <Check size={16} /> : <Plus size={16} />} Subscribe</button>}
          <button className="icon-button" type="button" aria-label={selectedIsSaved ? "Remove from saved videos" : "Save video"} onClick={() => toggleSave(selectedVideo)}><Bookmark size={19} fill={selectedIsSaved ? "currentColor" : "none"} /></button>
          <button className="icon-button" type="button" aria-label="Bookmark current timestamp" onClick={addBookmark}><Clock3 size={19} /></button>
        </div></div>
        {activeChapter && <p className="muted">Now playing chapter: {activeChapter.title}</p>}
      </div>
      <aside className="panel player-sidebar"><div className="panel-heading"><h2>Up next</h2></div>{renderVideoGrid(filteredVideos.filter((video) => videoId(video) !== currentId).slice(0, 8))}</aside>
    </section>
  );

  return (
    <div className="app-shell">
      <header className="top-nav" role="banner">
        <a href="#home" className="brand" onClick={(event) => { event.preventDefault(); setView("home"); }}><span className="brand-mark"><Play size={18} fill="currentColor" /></span><span className="brand-wordmark">TRICK A4IF TUBE</span></a>
        <form className="search-form" role="search" onSubmit={(event) => { event.preventDefault(); managers?.search?.addQueryToHistory(query); trackAppEvent("search", { queryLength: query.length }); }}>
          <input type="search" aria-label="Search videos" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your library" /><button type="submit" aria-label="Search"><Search size={19} /></button>
        </form>
        <div className="header-actions">
          {studio.pinLock?.enabled && unlocked && <button className="icon-button" aria-label="Lock app" type="button" onClick={() => setUnlocked(false)}><Lock size={19} /></button>}
          <button className="icon-button" aria-label="Toggle theme" type="button" onClick={() => changePreference("theme", getThemeMode(preferenceState?.theme) === "dark" ? "light" : "dark")}>{getThemeMode(preferenceState?.theme) === "dark" ? <Sun size={19} /> : <Moon size={19} />}</button>
        </div>
      </header>
      <div className="main-layout">
        <nav className="sidebar" aria-label="Main navigation">{VIEW_ITEMS.map(([id, label, Icon]) => <button key={id} type="button" className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}><Icon size={19} /><span>{label}</span></button>)}</nav>
        <main className="page-content" id="main-content">
          {statusMessage && <p className="badge" role="status">{statusMessage}</p>}
          {selectedVideo && <div style={{ marginBottom: 28 }}>{renderPlayer()}</div>}
          <div className="content-container">{renderView()}</div>
        </main>
      </div>
    </div>
  );
}

export function App({ videos = [] } = {}) {
  const telemetryRef = useRef(null);
  if (!telemetryRef.current) {
    try { telemetryRef.current = new ErrorBoundaryTelemetry({ maxErrors: 250 }); }
    catch { telemetryRef.current = null; }
  }
  return <AppErrorBoundary telemetry={telemetryRef.current}><AppContents videos={videos} /></AppErrorBoundary>;
}

export default App;
