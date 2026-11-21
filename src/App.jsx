import React, { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark, BookOpen, Check, Clock3, Film, History, ListVideo, Moon, Pause, Play,
  Plus, Search, Settings2, ShieldCheck, Sun, Tv2, Volume2, X,
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
  ["home", "Discover", Film], ["saved", "Saved", Bookmark], ["subscriptions", "Subscriptions", Tv2],
  ["history", "History", History], ["playlists", "Playlists", ListVideo], ["bookmarks", "Bookmarks", Clock3],
  ["chapters", "Chapters", BookOpen], ["sleep", "Sleep timer", Moon], ["safety", "Safety", ShieldCheck],
  ["preferences", "Preferences", Settings2], ["telemetry", "Telemetry", History],
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

/** Catch render and lifecycle errors at the UI boundary and retain a local report. */
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
    } catch { /* The fallback UI must remain available if telemetry itself fails. */ }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="page-content" role="alert">
        <section className="error-state">
          <h1>Something went wrong</h1>
          <p>The application encountered an error. Your locally stored data has not been intentionally cleared.</p>
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

function AppContents({ videos: suppliedVideos }) {
  const videoElement = useRef(null);
  const managerRef = useRef(null);
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

  useEffect(() => {
    let mounted = true;
    const unsubscribers = [];
    let created;
    try {
      const reportError = (error, instance) => {
        try { instance?.capture?.(error, { source: "feature-manager" }); } catch { /* Avoid cascading manager errors. */ }
      };
      const telemetry = new ErrorBoundaryTelemetry({ maxErrors: 250 });
      const search = new SearchFilterEngine({ historyLimit: 50, onError: (error) => reportError(error, telemetry) });
      const watchHistory = new WatchHistoryManager({ maxItems: 500, onChange: () => { if (mounted) setHistory([...watchHistory.getHistory()]); }, onError: (error) => reportError(error, telemetry) });
      const playlistManager = new PlaylistCollectionManager({ onChange: () => { if (mounted) setPlaylists([...playlistManager.getPlaylists()]); }, onError: (error) => reportError(error, telemetry) });
      const preferences = new UserPreferenceProfileManager({ onChange: () => { if (mounted) setPreferenceState(preferences.getPreferences()); }, onError: (error) => reportError(error, telemetry) });
      const safety = new ContentFilterSafetyGuard({ mode: "safety", onChange: () => { if (mounted) setSafetyMode(safety.mode); }, onError: (error) => reportError(error, telemetry) });
      const chapterManager = new VideoChapterManager({ onChange: () => { if (mounted && selectedVideo) setChapters([...chapterManager.getChapters(videoId(selectedVideo))]); }, onError: (error) => reportError(error, telemetry) });
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
          const active = selectedVideo;
          if (mounted && active) setChapters([...chapterManager.getChapters(videoId(active))]);
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
        try { if (typeof unsubscribe === "function") unsubscribe(); } catch { /* Continue complete teardown. */ }
      });
      const activeManagers = managerRef.current;
      managerRef.current = null;
      setManagers(null);
      if (activeManagers) {
        try { activeManagers.integrationHub?.destroy?.(); } catch { /* Continue teardown. */ }
        Object.entries(activeManagers).forEach(([name, manager]) => {
          if (name === "integrationHub" || name === "registry") return;
          try { manager?.destroy?.(); } catch { /* Teardown must not leak other resources. */ }
        });
        try { activeManagers.registry?.destroy?.(); } catch { /* Continue teardown. */ }
      }
    };
    // Managers are mounted once; selected-video state is read by dedicated effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!preferenceState) return;
    const mode = getThemeMode(preferenceState.theme);
    try { applyThemeToDocument(mode, null); } catch { /* CSS defaults remain usable if document styling is unavailable. */ }
  }, [preferenceState]);

  useEffect(() => {
    if (!selectedVideo || !managers) return;
    const id = videoId(selectedVideo);
    if (!id) return;
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
      try { managers?.telemetry?.capture(error, { source: "search and category filtering" }); } catch { /* Search can fail closed. */ }
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
      const video = selectedVideo;
      if (!video) return;
      const manager = managerRef.current;
      manager?.watchHistory?.update(video, { position: playbackTime, duration });
      void recordWatchHistory({ ...video, position: playbackTime, duration }).catch(() => {});
    } catch { /* Playback progress is best-effort local history. */ }
  }, [selectedVideo, playbackTime, duration]);

  const toggleSubscription = async (channelName, channelId) => {
    try {
      const id = text(channelId || channelName);
      if (id) await toggleChannelSubscription({ id, channelName: text(channelName) });
    } catch (error) { managers?.telemetry?.capture(error, { source: "channel subscription" }); }
  };

  const createPlaylist = (event) => {
    event.preventDefault();
    const name = playlistName.trim();
    if (!name || !managers) return;
    const playlist = managers.playlistManager.createPlaylist({ name });
    if (playlist && selectedVideo) managers.playlistManager.addItem(playlist.id, selectedVideo);
    setPlaylistName("");
  };

  const addBookmark = () => {
    if (!selectedVideo || !managers) return;
    const bookmark = managers.bookmarkManager.createBookmark({
      videoId: videoId(selectedVideo), timeSeconds: playbackTime, label: `${videoTitle(selectedVideo)} · ${formatTime(playbackTime)}`,
    });
    if (bookmark) setStatusMessage(`Bookmark added at ${formatTime(playbackTime)}.`);
  };

  const addChapter = () => {
    if (!selectedVideo || !managers) return;
    const title = globalThis.prompt?.("Chapter title")?.trim();
    if (!title) return;
    managers.chapterManager.addChapter(videoId(selectedVideo), { title, startTime: playbackTime });
    setChapters([...managers.chapterManager.getChapters(videoId(selectedVideo))]);
  };

  const changePreference = (key, value) => {
    try { managers?.preferences?.setPreference(key, value, { source: "user" }); }
    catch (error) { managers?.telemetry?.capture(error, { source: "preferences" }); }
  };

  const startTimer = () => {
    const minutes = Number(timerMinutes);
    if (Number.isFinite(minutes) && minutes > 0) managers?.sleepTimer?.startMinutes(minutes);
  };

  const activeCategory = CATEGORIES.find((item) => item.id === category)?.label ?? "All";
  const savedVideos = Object.values(saved).filter(isRecord);
  const subscribedChannels = Object.values(subscriptions).filter(isRecord);
  const currentId = videoId(selectedVideo);
  const selectedIsSaved = Boolean(saved[currentId]);
  const activeChapter = currentId ? managers?.chapterManager?.getActiveChapter(currentId, playbackTime, { totalDuration: duration }) : null;

  const renderVideoGrid = (list) => list.length ? (
    <div className="video-feed">{list.map((video) => <VideoCard key={videoId(video)} video={video} saved={Boolean(saved[videoId(video)])} onSelect={selectVideo} onSave={toggleSave} />)}</div>
  ) : <EmptyState>{sourceVideos.length ? "No videos match the current search and filters." : "Add video records through the App videos prop or window.__TRICK_A4IF_VIDEOS__ to populate your library."}</EmptyState>;

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
        <div className="header-actions"><button className="icon-button" aria-label="Toggle theme" type="button" onClick={() => changePreference("theme", getThemeMode(preferenceState?.theme) === "dark" ? "light" : "dark")}>{getThemeMode(preferenceState?.theme) === "dark" ? <Sun size={19} /> : <Moon size={19} />}</button></div>
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

/** Main Trick A4IF Tube interface; videos must come from the caller's library/feed. */
export function App({ videos = [] } = {}) {
  const telemetryRef = useRef(null);
  if (!telemetryRef.current) {
    try { telemetryRef.current = new ErrorBoundaryTelemetry({ maxErrors: 250 }); }
    catch { telemetryRef.current = null; }
  }
  return <AppErrorBoundary telemetry={telemetryRef.current}><AppContents videos={videos} /></AppErrorBoundary>;
}

export default App;
