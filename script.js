// PMVHaven plugin for Grayjay
// Provides: video listing, search, channels/profiles, recommendations, comments,
// playlist search/details, login, history sync, subscription/playlist migration.

const PLATFORM = "PMVHaven";
const BASE_URL = "https://pmvhaven.com";
const PLATFORM_CLAIMTYPE = 3;

const API_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9"
};

var config = {};
var pluginSettings = {
    syncRemoteHistory: false
};
var state = {
    isAuthenticated: false,
    username: "",
    userId: ""
};

// ---------- helpers ----------

function jsonGET(url) {
    const res = http.GET(url, API_HEADERS, false);
    if (!res.isOk) {
        throw new ScriptException("Request failed " + res.code + " for " + url);
    }
    try { return JSON.parse(res.body); }
    catch (e) { throw new ScriptException("Invalid JSON from " + url); }
}

function jsonGETNoThrow(url, useAuth) {
    try {
        const res = http.GET(url, API_HEADERS, useAuth === true);
        if (!res.isOk) return null;
        return JSON.parse(res.body);
    } catch (e) {
        log("jsonGETNoThrow failed for " + url + ": " + e);
        return null;
    }
}

function jsonRequest(method, url, body, useAuth) {
    try {
        const headers = Object.assign({ "Content-Type": "application/json" }, API_HEADERS);
        const payload = body ? JSON.stringify(body) : "";
        let res;
        if (method === "POST")      res = http.POST(url, payload, headers, useAuth === true);
        else if (method === "PUT")  res = (http.PUT ? http.PUT(url, payload, headers, useAuth === true)
                                                    : http.request("PUT", url, payload, headers, useAuth === true));
        else if (method === "DELETE") res = (http.DELETE ? http.DELETE(url, headers, useAuth === true)
                                                          : http.request("DELETE", url, "", headers, useAuth === true));
        else                        res = http.POST(url, payload, headers, useAuth === true);
        if (!res || !res.isOk) return null;
        if (!res.body) return { success: true };
        try { return JSON.parse(res.body); } catch (e) { return { success: true, raw: res.body }; }
    } catch (e) {
        log("jsonRequest " + method + " " + url + " failed: " + e);
        return null;
    }
}

function buildQuery(params) {
    const parts = [];
    for (const k in params) {
        if (params[k] === undefined || params[k] === null) continue;
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    }
    return parts.length ? "?" + parts.join("&") : "";
}

function parseDuration(duration) {
    if (typeof duration === "number") return duration;
    if (typeof duration === "string") {
        const parts = duration.split(":").map(a => parseInt(a, 10));
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
}

function parseDateSeconds(iso) {
    if (!iso) return 0;
    try {
        const t = Date.parse(iso);
        if (!isFinite(t)) return 0;
        return Math.floor(t / 1000);
    } catch (e) { return 0; }
}

function slugifyTitle(title) {
    return (title || "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function videoUrlFromIdTitle(id, title) {
    const slug = slugifyTitle(title);
    return BASE_URL + "/video/" + (slug ? slug + "_" : "") + id;
}

function channelUrlFromUsername(username) {
    return BASE_URL + "/profile/" + username;
}

function playlistUrlFromId(id) {
    return BASE_URL + "/playlists/" + id;
}

function extractVideoIdFromUrl(url) {
    if (!url) return null;
    // matches /video/<slug>_<id> or /video/<id>
    const m = url.match(/\/video\/(?:[^_\/?#]+_)?([a-f0-9]{24})/i);
    if (m) return m[1];
    // standalone id
    const m2 = url.match(/([a-f0-9]{24})/i);
    return m2 ? m2[1] : null;
}

function extractUsernameFromProfileUrl(url) {
    const m = url.match(/\/profile\/([^\/\?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
}

function extractPlaylistIdFromUrl(url) {
    const m = url.match(/\/playlists?\/([a-f0-9]{24})/i);
    return m ? m[1] : null;
}

// ---------- builders ----------

function createAuthor(uploaderName, uploaderUsername, uploaderAvatarUrl) {
    const name = uploaderUsername || uploaderName || "";
    if (!name) {
        return new PlatformAuthorLink(
            new PlatformID(PLATFORM, "", config.id),
            "", "", ""
        );
    }
    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, name, config.id),
        name,
        channelUrlFromUsername(name),
        uploaderAvatarUrl || ""
    );
}

function toPlatformVideo(v) {
    const id = v._id || v.id || "";
    const vidurl = videoUrlFromIdTitle(id, v.title || "");
    const thumbUrl = v.thumbnailUrl || (v.thumbnailSizes && (v.thumbnailSizes.lg || v.thumbnailSizes.md)) || "";
    const durationSec = (typeof v.durationSeconds === "number" && v.durationSeconds > 0)
        ? v.durationSeconds
        : parseDuration(v.duration);

    const pv = new PlatformVideo({
        id: new PlatformID(PLATFORM, id, config.id),
        name: v.title || "Untitled",
        thumbnails: thumbUrl ? new Thumbnails([new Thumbnail(thumbUrl, 720)]) : new Thumbnails([]),
        author: createAuthor(v.uploader, v.uploaderUsername, v.uploaderAvatarUrl),
        datetime: parseDateSeconds(v.uploadDate || v.createdAt),
        duration: durationSec,
        viewCount: v.views || 0,
        url: vidurl,
        isLive: false
    });
    // Resume-point hydration when the server has returned the logged-in user's
    // watch progress on the video document.
    if (typeof v.watchProgress === "number" && v.watchProgress > 0) {
        try { pv.playbackTime = Math.floor(v.watchProgress); } catch (e) { /* ignore */ }
    }
    if (v.lastWatchedAt) {
        try { pv.playbackDate = parseDateSeconds(v.lastWatchedAt); } catch (e) { /* ignore */ }
    }
    return pv;
}

function toPlatformChannel(user, subscriberCount) {
    const username = user.username || "";
    return new PlatformChannel({
        id: new PlatformID(PLATFORM, username, config.id, PLATFORM_CLAIMTYPE),
        name: username,
        thumbnail: user.avatarUrl || "",
        banner: user.bannerUrl || "",
        subscribers: subscriberCount || 0,
        description: user.bio || "",
        url: channelUrlFromUsername(username),
        urlAlternatives: [channelUrlFromUsername(username)],
        links: user.socialLinks ? cleanSocialLinks(user.socialLinks) : {}
    });
}

function cleanSocialLinks(links) {
    const out = {};
    const map = { website: "Website", twitter: "Twitter", discord: "Discord", telegram: "Telegram" };
    for (const k in map) {
        const v = links[k];
        if (v && typeof v === "string" && v.length > 0) out[map[k]] = v;
    }
    return out;
}

// ---------- source plugin ----------

source.enable = function(conf, settings, savedState) {
    config = conf || {};
    if (settings && typeof settings.syncRemoteHistory !== "undefined") {
        const v = settings.syncRemoteHistory;
        pluginSettings.syncRemoteHistory = (v === true) || (typeof v === "string" && v.toLowerCase() === "true");
    }
    if (savedState) {
        try {
            const s = JSON.parse(savedState);
            state.username = s.username || "";
            state.userId = s.userId || "";
            state.isAuthenticated = !!s.isAuthenticated;
        } catch (e) { /* ignore */ }
    }
    // If Grayjay tells us the user is logged in (via its built-in bridge), trust it.
    try {
        if (typeof bridge !== "undefined" && bridge && typeof bridge.isLoggedIn === "function" && bridge.isLoggedIn()) {
            state.isAuthenticated = true;
        }
    } catch (e) { /* ignore */ }
    log("PMVHaven plugin enabled. syncRemoteHistory=" + pluginSettings.syncRemoteHistory +
        " auth=" + state.isAuthenticated);
};

source.disable = function() {
    state.isAuthenticated = false;
    state.username = "";
    state.userId = "";
};

source.setSettings = function(newsettings) {
    if (!newsettings) return;
    if (typeof newsettings.syncRemoteHistory !== "undefined") {
        const v = newsettings.syncRemoteHistory;
        pluginSettings.syncRemoteHistory = (v === true) || (typeof v === "string" && v.toLowerCase() === "true");
    }
};

source.saveState = function() {
    return JSON.stringify({
        isAuthenticated: state.isAuthenticated,
        username: state.username,
        userId: state.userId
    });
};

source.getCapabilities = function() {
    return {
        hasSyncRemoteWatchHistory: !!pluginSettings.syncRemoteHistory,
        hasGetUserSubscriptions: true,
        hasGetUserPlaylists: true
    };
};

// ---------- auth ----------

function fetchUserInfo() {
    // Pull username/userId from /api/auth/get-session using current cookies.
    try {
        const res = http.GET(BASE_URL + "/api/auth/get-session", API_HEADERS, true);
        if (!res || !res.isOk) return false;
        const body = (res.body || "").trim();
        if (!body || body === "null") return false;
        const json = JSON.parse(body);
        const user = json.user || (json.session && json.session.user) || json.data;
        if (user && (user.id || user._id || user.userId)) {
            state.userId = user.id || user._id || user.userId;
            state.username = user.username || user.name || state.username || "";
            return true;
        }
    } catch (e) {
        log("fetchUserInfo error: " + e);
    }
    return false;
}

function bridgeIsLoggedIn() {
    try {
        if (typeof bridge !== "undefined" && bridge && typeof bridge.isLoggedIn === "function") {
            return !!bridge.isLoggedIn();
        }
    } catch (e) { /* ignore */ }
    return false;
}

source.isLoggedIn = function() {
    try {
        // 1) Trust Grayjay's bridge signal first — once it has captured the
        //    required cookies via its login web view, this is the authoritative
        //    indicator that the user finished the flow.
        if (bridgeIsLoggedIn()) {
            state.isAuthenticated = true;
            if (!state.username) fetchUserInfo();
            return true;
        }
        // 2) Fallback: ask the server with our stored cookies.
        if (fetchUserInfo()) {
            state.isAuthenticated = true;
            return true;
        }
        state.isAuthenticated = false;
        return false;
    } catch (e) {
        log("isLoggedIn error: " + e);
        return false;
    }
};

source.getLoggedInUser = function() {
    try {
        if (!source.isLoggedIn()) return null;
        if (!state.username) fetchUserInfo();
        return state.username || "Logged In";
    } catch (e) { return null; }
};

// IMPORTANT: Grayjay shows "Login cancelled" whenever this returns false (or
// throws). SB-GJ never returns false here — it trusts that Grayjay's web view
// captured the cookies and returns true unconditionally. We do the same:
// the actual session check is deferred to isLoggedIn()/getLoggedInUser() so
// the user can re-validate later from settings without aborting the flow.
source.login = function() {
    try {
        state.isAuthenticated = true;
        // Best-effort: try to populate the username right away.
        try { fetchUserInfo(); } catch (e) { /* ignore */ }
        log("login(): accepted - cookies captured by Grayjay");
        return true;
    } catch (e) {
        log("login error: " + e);
        // Still return true so Grayjay does not display "Login cancelled".
        // isLoggedIn() will resolve the real state on the next call.
        return true;
    }
};

source.logout = function() {
    state.isAuthenticated = false;
    state.username = "";
    state.userId = "";
    try {
        if (typeof http.clearCookies === "function") http.clearCookies("pmvhaven.com");
        if (typeof bridge !== "undefined" && bridge && bridge.clearCookies) bridge.clearCookies("pmvhaven.com");
    } catch (e) { /* ignore */ }
};

// ---------- home ----------

source.getHome = function() {
    // The /api/videos/trending endpoint is NOT paginated: it returns the same
    // fixed set on every page, which made Grayjay's home feed repeat forever.
    // Use the browse endpoint (/api/videos) which paginates correctly.
    return new VideosApiPager("browse", { sort: "-uploadDate" });
};

// ---------- search ----------

source.searchSuggestions = function(query) { return []; };

// Search filter constants (must match values used in search())
const SORT_OPTIONS = ["Relevance", "Newest", "Oldest", "Most Viewed", "Most Liked", "Top Rated"];
const SORT_MAP = {
    "Relevance":    "",
    "Newest":       "-uploadDate",
    "Oldest":       "uploadDate",
    "Most Viewed":  "-views",
    "Most Liked":   "-likes",
    "Top Rated":    "-bayesianRating"
};
const DATE_DAYS = { "today": 1, "7days": 7, "30days": 30, "365days": 365 };
const DURATION_MAP = {
    "0-5":   { durationMax: 5 * 60 },
    "5-20":  { durationMin: 5 * 60, durationMax: 20 * 60 },
    "20+":   { durationMin: 20 * 60 }
};
// Popular PMVHaven tags used to build the "Category" filter (multi-select).
const CATEGORY_FILTERS = [
    { name: "Any",            value: "" },
    { name: "Amateur",        value: "amateur" },
    { name: "Anal",           value: "anal" },
    { name: "Asian",          value: "asian" },
    { name: "Big Ass",        value: "big ass" },
    { name: "Big Tits",       value: "big tits" },
    { name: "Blonde",         value: "blonde" },
    { name: "Blowjob",        value: "blowjob" },
    { name: "Brunette",       value: "brunette" },
    { name: "Cosplay",        value: "cosplay" },
    { name: "Cowgirl",        value: "cowgirl" },
    { name: "Creampie",       value: "creampie" },
    { name: "Cum",            value: "cum" },
    { name: "Cumshot",        value: "cumshot" },
    { name: "Cute",           value: "cute" },
    { name: "Dancing",        value: "dancing" },
    { name: "Deepthroat",     value: "deepthroat" },
    { name: "Doggystyle",     value: "doggystyle" },
    { name: "Facial",         value: "facial" },
    { name: "Gangbang",       value: "gangbang" },
    { name: "Goon",           value: "goon" },
    { name: "Hardcore",       value: "hardcore" },
    { name: "Hentai",         value: "hentai" },
    { name: "HMV",            value: "hmv" },
    { name: "Hypno",          value: "hypno" },
    { name: "Interracial",    value: "interracial" },
    { name: "Japanese",       value: "japanese" },
    { name: "JAV",            value: "jav" },
    { name: "MILF",           value: "milf" },
    { name: "POV",            value: "pov" },
    { name: "PAWG",           value: "pawg" },
    { name: "Riding",         value: "riding" },
    { name: "Sissy",          value: "sissy" },
    { name: "Splitscreen",    value: "splitscreen" },
    { name: "Teasing",        value: "teasing" },
    { name: "Teen",           value: "teen" },
    { name: "TikTok",         value: "tiktok" },
    { name: "Twerking",       value: "twerking" },
    { name: "3D",             value: "3d" }
];

source.getSearchCapabilities = function() {
    return {
        types: [Type.Feed.Mixed, Type.Feed.Videos, Type.Feed.Channels, Type.Feed.Playlists],
        sorts: SORT_OPTIONS,
        filters: [
            {
                id: "date",
                name: "Date",
                isMultiSelect: false,
                filters: [
                    { name: "Any time",     value: "" },
                    { name: "Today",        value: "today" },
                    { name: "Last 7 days",  value: "7days" },
                    { name: "Last 30 days", value: "30days" },
                    { name: "Last year",    value: "365days" }
                ]
            },
            {
                id: "duration",
                name: "Duration",
                isMultiSelect: false,
                filters: [
                    { name: "Any",       value: "" },
                    { name: "0-5 min",   value: "0-5" },
                    { name: "5-20 min",  value: "5-20" },
                    { name: "20+ min",   value: "20+" }
                ]
            },
            {
                id: "category",
                name: "Category",
                isMultiSelect: true,
                filters: CATEGORY_FILTERS
            }
        ]
    };
};

function buildSearchFilterParams(order, filters) {
    const out = {};
    if (order && SORT_MAP[order] !== undefined && SORT_MAP[order] !== "") {
        out.sort = SORT_MAP[order];
    }
    if (filters && typeof filters === "object") {
        const date = pickFilter(filters, "date");
        if (date && DATE_DAYS[date]) {
            const from = new Date(Date.now() - DATE_DAYS[date] * 24 * 3600 * 1000);
            out.uploadDateFrom = from.toISOString();
        }
        const dur = pickFilter(filters, "duration");
        if (dur && DURATION_MAP[dur]) Object.assign(out, DURATION_MAP[dur]);
        const tags = pickFilterAll(filters, "category").filter(t => t && t.length > 0);
        if (tags.length) out.tags = tags.join(",");
    }
    return out;
}

function pickFilter(filters, id) {
    if (!filters) return null;
    const v = filters[id];
    if (Array.isArray(v)) return v.length ? v[0] : null;
    return v || null;
}

function pickFilterAll(filters, id) {
    if (!filters) return [];
    const v = filters[id];
    if (Array.isArray(v)) return v.slice();
    return v ? [v] : [];
}

source.search = function(query, type, order, filters) {
    if (type === Type.Feed.Channels) return source.searchChannels(query);
    if (type === Type.Feed.Playlists) return source.searchPlaylists(query);
    const extra = buildSearchFilterParams(order, filters);
    return new VideosApiPager("search", Object.assign({ q: query }, extra));
};

source.searchChannels = function(query) {
    try {
        const data = jsonGETNoThrow(BASE_URL + "/api/users/search" + buildQuery({ q: query }));
        const users = (data && data.users) || [];
        const channels = users.map(u => new PlatformChannel({
            id: new PlatformID(PLATFORM, u.username, config.id, PLATFORM_CLAIMTYPE),
            name: u.displayName || u.username,
            thumbnail: u.avatarUrl || "",
            banner: "",
            subscribers: 0,
            description: "",
            url: channelUrlFromUsername(u.username),
            links: {}
        }));
        return new ChannelPager(channels, false);
    } catch (e) {
        log("searchChannels error: " + e);
        return new ChannelPager([], false);
    }
};

source.searchPlaylists = function(query) {
    return new PlaylistsApiPager(query);
};

// ---------- channel ----------

source.isChannelUrl = function(url) {
    return /^https?:\/\/(?:www\.)?pmvhaven\.com\/profile\/[^\/\?#]+/.test(url);
};

source.getChannel = function(url) {
    const username = extractUsernameFromProfileUrl(url);
    if (!username) throw new ScriptException("Invalid channel URL: " + url);

    const profile = jsonGETNoThrow(BASE_URL + "/api/users/by-username/" + encodeURIComponent(username));
    if (!profile || !profile.data) {
        throw new ScriptException("Profile not found for " + username);
    }
    const userData = profile.data;
    const userId = userData._id;

    let subCount = 0;
    try {
        const sc = jsonGETNoThrow(BASE_URL + "/api/users/" + userId + "/subscriber-count");
        if (sc && typeof sc.count === "number") subCount = sc.count;
    } catch (e) { /* ignore */ }

    return toPlatformChannel(userData, subCount);
};

source.getChannelCapabilities = function() {
    return {
        types: [Type.Feed.Videos],
        sorts: [Type.Order.Chronological],
        filters: []
    };
};

source.getChannelContents = function(url) {
    const username = extractUsernameFromProfileUrl(url);
    if (!username) return new ContentPager([], false);
    return new ChannelVideosPager(username);
};

source.getChannelVideos = function(url) {
    return source.getChannelContents(url);
};

// ---------- video ----------

source.isContentDetailsUrl = function(url) {
    return /^https?:\/\/(?:www\.)?pmvhaven\.com\/video\//.test(url);
};

source.getContentDetails = function(url) {
    const id = extractVideoIdFromUrl(url);
    if (!id) throw new ScriptException("Could not extract video id from " + url);

    const resp = jsonGETNoThrow(BASE_URL + "/api/videos/" + id);
    if (!resp || !resp.data) throw new ScriptException("Video not found: " + id);
    const v = resp.data;

    const sources = [];
    if (v.hlsEnabled && v.hlsMasterPlaylistUrl) {
        sources.push(new HLSSource({
            name: "HLS",
            duration: v.durationSeconds || parseDuration(v.duration),
            url: v.hlsMasterPlaylistUrl
        }));
    }
    if (v.videoUrl) {
        sources.push(new VideoUrlSource({
            container: v.contentType || "video/mp4",
            name: (v.width && v.height) ? (v.height + "p") : "mp4",
            width: v.width || 0,
            height: v.height || 0,
            url: v.videoUrl,
            duration: v.durationSeconds || parseDuration(v.duration)
        }));
    }

    const details = new PlatformVideoDetails({
        id: new PlatformID(PLATFORM, id, config.id),
        name: v.title || "Untitled",
        thumbnails: v.thumbnailUrl ? new Thumbnails([new Thumbnail(v.thumbnailUrl, 720)]) : new Thumbnails([]),
        author: createAuthor(v.uploader, v.uploaderUsername, v.uploaderAvatarUrl),
        datetime: parseDateSeconds(v.uploadDate || v.createdAt),
        duration: v.durationSeconds || parseDuration(v.duration),
        viewCount: v.views || 0,
        url: url,
        isLive: false,
        description: v.description || "",
        video: new VideoSourceDescriptor(sources),
        rating: new RatingLikesDislikes(v.likes || 0, v.dislikes || 0)
    });
    if (typeof v.watchProgress === "number" && v.watchProgress > 0) {
        try { details.playbackTime = Math.floor(v.watchProgress); } catch (e) { /* ignore */ }
    }
    // Grayjay reads recommended videos from a method on the details object
    // itself (see uarasio/SB-GJ for the same pattern). Without this hook the
    // "More videos" rail under a video stays empty even if
    // source.getContentRecommendations is defined.
    details.getContentRecommendations = function() {
        return source.getContentRecommendations(url, details);
    };
    return details;
};

// ---------- actions (subscribe / like / dislike / watch-progress push) ----------

source.actionSubscribe = function(channelUrl, subscribe) {
    try {
        const username = extractUsernameFromProfileUrl(channelUrl);
        if (!username) return false;
        const profile = jsonGETNoThrow(BASE_URL + "/api/users/by-username/" + encodeURIComponent(username));
        const userId = profile && profile.data && profile.data._id;
        if (!userId) return false;
        const r = jsonRequest("PUT", BASE_URL + "/api/users/" + userId + "/subscribe",
            { action: subscribe === false ? "unsubscribe" : "subscribe" }, true);
        return !!r;
    } catch (e) { log("actionSubscribe error: " + e); return false; }
};

source.actionLike = function(videoUrl, like) {
    const id = extractVideoIdFromUrl(videoUrl);
    if (!id) return false;
    const r = jsonRequest("PUT", BASE_URL + "/api/videos/" + id + "/like",
        { action: like === false ? "unlike" : "like" }, true);
    return !!r;
};

source.actionDislike = function(videoUrl, dislike) {
    const id = extractVideoIdFromUrl(videoUrl);
    if (!id) return false;
    const r = jsonRequest("PUT", BASE_URL + "/api/videos/" + id + "/dislike",
        { action: dislike === false ? "undislike" : "dislike" }, true);
    return !!r;
};

// Push local playback progress back to the server (called by Grayjay when the
// user pauses / leaves a video, if Grayjay reflects the hook).
source.savePlaybackState = function(url, watchTimeSeconds) {
    try {
        if (!source.isLoggedIn()) return false;
        const id = extractVideoIdFromUrl(url);
        if (!id) return false;
        const progress = Math.max(0, Math.round(Number(watchTimeSeconds) || 0));
        const r = jsonRequest("PUT", BASE_URL + "/api/users/watch-progress",
            { videoId: id, progress: progress }, true);
        return !!r;
    } catch (e) { log("savePlaybackState error: " + e); return false; }
};
// Alias for compatibility with possible Grayjay hook names.
source.actionWatchProgress = source.savePlaybackState;

source.getContentRecommendations = function(url, initialData) {
    const id = extractVideoIdFromUrl(url);
    if (!id) return new ContentPager([], false);
    try {
        const data = jsonGETNoThrow(BASE_URL + "/api/videos/" + id + "/recommendations-es?limit=20");
        const list = (data && (data.videos || data.data)) || [];
        const vids = list.map(toPlatformVideo);
        return new ContentPager(vids, false);
    } catch (e) {
        log("recommendations error: " + e);
        return new ContentPager([], false);
    }
};

// ---------- comments ----------

source.getComments = function(url) {
    const id = extractVideoIdFromUrl(url);
    if (!id) return new CommentPager([], false);
    return new VideoCommentPager(url, id, 1);
};

source.getSubComments = function(comment) {
    if (!comment || !comment.context) return new CommentPager([], false);
    const replies = comment.context.replies || [];
    return new CommentPager(
        replies.map(r => buildComment(r, comment.context.videoUrl, comment.context.videoId, null)),
        false
    );
};

function buildComment(c, videoUrl, videoId, parentForReplies) {
    const author = c.username
        ? new PlatformAuthorLink(
            new PlatformID(PLATFORM, c.username, config.id),
            c.username,
            channelUrlFromUsername(c.username),
            c.avatarUrl || ""
          )
        : new PlatformAuthorLink(new PlatformID(PLATFORM, "", config.id), "", "", "");
    const replyCount = Array.isArray(c.replies) ? c.replies.length : 0;
    return new Comment({
        contextUrl: videoUrl,
        author: author,
        message: c.text || "",
        rating: new RatingLikesDislikes(c.likes || 0, c.dislikes || 0),
        date: parseDateSeconds(c.createdAt),
        replyCount: replyCount,
        context: {
            videoUrl: videoUrl,
            videoId: videoId,
            replies: c.replies || []
        }
    });
}

// ---------- playlist ----------

source.isPlaylistUrl = function(url) {
    return /^https?:\/\/(?:www\.)?pmvhaven\.com\/playlists\/[a-f0-9]{24}/i.test(url);
};

source.getPlaylist = function(url) {
    const id = extractPlaylistIdFromUrl(url);
    if (!id) throw new ScriptException("Invalid playlist URL: " + url);
    const resp = jsonGETNoThrow(BASE_URL + "/api/playlists/" + id);
    if (!resp || !resp.data) throw new ScriptException("Playlist not found: " + id);
    const p = resp.data;
    const ownerName = p.ownerUsername || p.owner || "";
    const author = ownerName
        ? new PlatformAuthorLink(
            new PlatformID(PLATFORM, ownerName, config.id),
            ownerName,
            channelUrlFromUsername(ownerName),
            p.ownerAvatarUrl || ""
          )
        : new PlatformAuthorLink(new PlatformID(PLATFORM, "", config.id), "", "", "");

    const details = (p.videoDetails || []).map(toPlatformVideo);

    return new PlatformPlaylistDetails({
        id: new PlatformID(PLATFORM, id, config.id),
        name: p.name || "Playlist",
        thumbnail: p.thumbnail || (details.length ? "" : ""),
        author: author,
        datetime: parseDateSeconds(p.createdAt),
        url: url,
        videoCount: details.length,
        contents: new VideoPager(details, false)
    });
};

// ---------- subscription/playlist migration ----------

source.getUserSubscriptions = function() {
    // Returns list of channel URLs the logged-in user is subscribed to.
    try {
        if (!source.isLoggedIn()) {
            log("getUserSubscriptions: not logged in");
            return [];
        }
        if (!state.userId) return [];
        const resp = jsonGETNoThrow(BASE_URL + "/api/users/" + state.userId + "/subscriptions", true);
        const list = (resp && resp.data) || [];
        return list.filter(u => u && u.username).map(u => channelUrlFromUsername(u.username));
    } catch (e) {
        log("getUserSubscriptions error: " + e);
        return [];
    }
};

source.getUserPlaylists = function() {
    // Returns list of playlist URLs owned by the logged-in user.
    try {
        if (!source.isLoggedIn()) {
            log("getUserPlaylists: not logged in");
            return [];
        }
        if (!state.userId && !state.username) return [];
        const ownerParam = state.userId || state.username;
        const resp = jsonGETNoThrow(BASE_URL + "/api/playlists" + buildQuery({
            owner: ownerParam,
            isPublic: true,
            limit: 100
        }), true);
        const list = (resp && resp.data) || [];
        return list.filter(pl => pl && pl._id).map(pl => playlistUrlFromId(pl._id));
    } catch (e) {
        log("getUserPlaylists error: " + e);
        return [];
    }
};

// ---------- remote watch history ----------

source.syncRemoteWatchHistory = function(continuationToken) {
    try {
        if (!source.isLoggedIn()) {
            log("syncRemoteWatchHistory: not logged in");
            return new VideoPager([], false, { token: null });
        }

        // Page through /api/user/watched-video-ids (cookie-auth)
        const page = continuationToken ? parseInt(continuationToken, 10) : 1;
        const resp = jsonGETNoThrow(BASE_URL + "/api/user/watched-video-ids" + buildQuery({
            page: page, limit: 50
        }), true);
        if (!resp) return new VideoPager([], false, { token: null });

        // Accept multiple shapes: {data:[ids]}, {videoIds:[]}, {data:[{videoId,watchedAt}]}
        let entries = resp.data || resp.videoIds || resp.watched || [];
        if (!Array.isArray(entries)) entries = [];

        const out = [];
        const now = Math.floor(Date.now() / 1000);
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const videoId = typeof e === "string" ? e : (e.videoId || e._id || e.id);
            if (!videoId) continue;
            const watchedAt = (e && e.watchedAt) ? parseDateSeconds(e.watchedAt) : (now - (page - 1) * 50 * 3600 - i * 3600);
            const vd = jsonGETNoThrow(BASE_URL + "/api/videos/" + videoId);
            if (!vd || !vd.data) continue;
            const v = vd.data;
            const pv = toPlatformVideo(v);
            // Decorate with playback markers (Grayjay reads them from the platform video)
            try {
                pv.playbackDate = watchedAt;
                pv.playbackTime = v.watchProgress || 0;
            } catch (err) { /* ignore */ }
            out.push(pv);
        }

        const hasMore = entries.length >= 50;
        return new VideoPager(out, hasMore, { token: String(page + 1) });
    } catch (e) {
        log("syncRemoteWatchHistory error: " + e);
        return new VideoPager([], false, { token: null });
    }
};

// ---------- pagers ----------

class VideosApiPager extends ContentPager {
    constructor(kind, payload) {
        super([], true);
        this.kind = kind; // "browse", "search" or "trending"
        this.payload = payload || {};
        this.page = 0;
        this.seen = {};
        this.nextPage();
    }
    nextPage() {
        this.page++;
        // PMVHaven's API paginates with `page` (the previous `index` param was
        // silently ignored, which is why feeds repeated the same results). The
        // browse feed lives at /api/videos, search/trending have sub-paths.
        const path = (this.kind === "browse") ? "/api/videos" : ("/api/videos/" + this.kind);
        const url = BASE_URL + path + buildQuery(
            Object.assign({}, this.payload, { page: this.page, limit: 50 })
        );
        const data = jsonGETNoThrow(url);
        if (!data || data.success === false) { this.hasMore = false; this.results = []; return this; }
        const list = data.videos || data.data || [];
        // De-duplicate across pages so already-seen videos never reappear.
        const fresh = [];
        for (let i = 0; i < list.length; i++) {
            const v = list[i];
            const id = v && (v._id || v.id);
            if (!id || this.seen[id]) continue;
            this.seen[id] = true;
            fresh.push(toPlatformVideo(v));
        }
        this.results = fresh;
        const pag = data.pagination || {};
        if (typeof pag.hasNext === "boolean") this.hasMore = pag.hasNext;
        else this.hasMore = list.length >= 50;
        return this;
    }
}

class ChannelVideosPager extends ContentPager {
    constructor(username) {
        super([], true);
        this.username = username;
        this.page = 0;
        this.nextPage();
    }
    nextPage() {
        this.page++;
        const url = BASE_URL + "/api/videos" + buildQuery({
            uploader: this.username,
            page: this.page,
            limit: 50
        });
        const data = jsonGETNoThrow(url);
        if (!data) { this.hasMore = false; this.results = []; return this; }
        const list = data.videos || data.data || [];
        this.results = list.map(toPlatformVideo);
        const pagination = data.pagination || {};
        this.hasMore = pagination.hasNext === true || this.results.length >= 50;
        return this;
    }
}

class PlaylistsApiPager extends PlaylistPager {
    constructor(query) {
        super([], true);
        this.query = query;
        this.page = 0;
        this.seen = {};
        this.nextPage();
    }
    nextPage() {
        this.page++;
        // Use `page` (not the ignored `index`) so playlist search actually
        // advances instead of returning page 1 over and over.
        const url = BASE_URL + "/api/playlists/search" + buildQuery({
            q: this.query, page: this.page, limit: 20
        });
        const data = jsonGETNoThrow(url);
        const list = (data && data.data) || [];
        const out = [];
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            if (!p || !p._id || this.seen[p._id]) continue;
            this.seen[p._id] = true;
            const ownerName = p.ownerUsername || "";
            const author = ownerName
                ? new PlatformAuthorLink(
                    new PlatformID(PLATFORM, ownerName, config.id),
                    ownerName,
                    channelUrlFromUsername(ownerName),
                    ""
                  )
                : new PlatformAuthorLink(new PlatformID(PLATFORM, "", config.id), "", "", "");
            out.push(new PlatformPlaylist({
                id: new PlatformID(PLATFORM, p._id, config.id),
                name: p.name || "Playlist",
                thumbnail: p.thumbnailUrl || "",
                author: author,
                datetime: parseDateSeconds(p.createdAt),
                url: playlistUrlFromId(p._id),
                videoCount: p.videoCount || 0
            }));
        }
        this.results = out;
        const meta = (data && data.meta) || {};
        if (typeof meta.hasMore === "boolean") this.hasMore = meta.hasMore;
        else this.hasMore = list.length >= 20;
        return this;
    }
}

class VideoCommentPager extends CommentPager {
    constructor(videoUrl, videoId, page) {
        super([], true);
        this.videoUrl = videoUrl;
        this.videoId = videoId;
        this.page = page || 1;
        this._loadPage();
    }
    _loadPage() {
        const url = BASE_URL + "/api/videos/" + this.videoId + "/comments" + buildQuery({
            index: this.page, limit: 50
        });
        const data = jsonGETNoThrow(url);
        const list = (data && data.data) || [];
        const filtered = list.filter(c => !c.shadowBanned);
        this.results = filtered.map(c => buildComment(c, this.videoUrl, this.videoId, null));
        // Honour real pagination metadata when the API returns it
        const p = data && data.pagination;
        if (p && typeof p.hasNext === "boolean") this.hasMore = p.hasNext;
        else if (p && typeof p.totalPages === "number") this.hasMore = this.page < p.totalPages;
        else this.hasMore = filtered.length >= 50;
    }
    nextPage() {
        this.page++;
        this._loadPage();
        return this;
    }
}

log("PMVHaven plugin loaded");
