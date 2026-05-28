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
    log("PMVHaven plugin enabled. syncRemoteHistory=" + pluginSettings.syncRemoteHistory);
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

source.isLoggedIn = function() {
    try {
        // Hit session endpoint with stored cookies (useAuth=true)
        const res = http.GET(BASE_URL + "/api/auth/get-session", API_HEADERS, true);
        if (!res.isOk) return false;
        const body = (res.body || "").trim();
        if (!body || body === "null") return false;
        const json = JSON.parse(body);
        const user = json.user || (json.session && json.session.user);
        if (user && (user.id || user.userId)) {
            state.userId = user.id || user.userId;
            state.username = user.username || user.name || state.username;
            state.isAuthenticated = true;
            return true;
        }
        return false;
    } catch (e) {
        log("isLoggedIn error: " + e);
        return false;
    }
};

source.getLoggedInUser = function() {
    try {
        if (state.username && state.isAuthenticated) return state.username;
        if (source.isLoggedIn()) return state.username || "Logged In";
        return null;
    } catch (e) { return null; }
};

source.login = function() {
    try {
        source.isLoggedIn();
        return state.isAuthenticated;
    } catch (e) { return false; }
};

source.logout = function() {
    state.isAuthenticated = false;
    state.username = "";
    state.userId = "";
    try {
        if (typeof http.clearCookies === "function") http.clearCookies("pmvhaven.com");
        if (typeof bridge !== "undefined" && bridge.clearCookies) bridge.clearCookies("pmvhaven.com");
    } catch (e) { /* ignore */ }
};

// ---------- home ----------

source.getHome = function() {
    return new VideosApiPager("trending", { period: "24h" });
};

// ---------- search ----------

source.searchSuggestions = function(query) { return []; };

// Search filter constants (must match values used in search())
const SORT_OPTIONS = [
    "Relevance", "Newest", "Oldest", "Most Popular", "Most Liked"
];
const SORT_MAP = {
    "Relevance": "",
    "Newest": "-uploadDate",
    "Oldest": "uploadDate",
    "Most Popular": "-bayesianRating",
    "Most Liked": "-likes"
};
const DATE_OPTIONS = ["Any Time", "Today", "Last 7 Days", "Last 30 Days", "Last Year"];
const DATE_DAYS = { "Today": 1, "Last 7 Days": 7, "Last 30 Days": 30, "Last Year": 365 };
const DURATION_OPTIONS = ["Any", "0-5 min", "5-20 min", "20+ min"];
const DURATION_MAP = {
    "0-5 min": { durationMax: 5 * 60 },
    "5-20 min": { durationMin: 5 * 60, durationMax: 20 * 60 },
    "20+ min": { durationMin: 20 * 60 }
};
const QUALITY_OPTIONS = ["Any", "4K", "QHD", "FHD", "HD", "SD"];
const QUALITY_MAP = {
    "4K":  { minHeight: 2160 },
    "QHD": { minHeight: 1440, maxHeight: 2159 },
    "FHD": { minHeight: 1080, maxHeight: 1439 },
    "HD":  { minHeight: 720,  maxHeight: 1079 },
    "SD":  { maxHeight: 719 }
};

source.getSearchCapabilities = function() {
    return {
        types: [Type.Feed.Mixed, Type.Feed.Videos, Type.Feed.Channels, Type.Feed.Playlists],
        sorts: SORT_OPTIONS,
        filters: [
            { name: "Date",     type: "dropdown", filters: DATE_OPTIONS.map(v => ({ name: v, value: v })) },
            { name: "Duration", type: "dropdown", filters: DURATION_OPTIONS.map(v => ({ name: v, value: v })) },
            { name: "Quality",  type: "dropdown", filters: QUALITY_OPTIONS.map(v => ({ name: v, value: v })) }
        ]
    };
};

function buildSearchFilterParams(order, filters) {
    const out = {};
    if (order && SORT_MAP[order] !== undefined) {
        if (SORT_MAP[order]) out.sort = SORT_MAP[order];
    }
    if (filters) {
        const date = pickFilter(filters, "Date");
        if (date && DATE_DAYS[date]) {
            const from = new Date(Date.now() - DATE_DAYS[date] * 24 * 3600 * 1000);
            out.uploadDateFrom = from.toISOString();
        }
        const dur = pickFilter(filters, "Duration");
        if (dur && DURATION_MAP[dur]) Object.assign(out, DURATION_MAP[dur]);
        const q = pickFilter(filters, "Quality");
        if (q && QUALITY_MAP[q]) Object.assign(out, QUALITY_MAP[q]);
    }
    return out;
}

function pickFilter(filters, name) {
    if (!filters) return null;
    const v = filters[name];
    if (Array.isArray(v)) return v.length ? v[0] : null;
    return v || null;
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
        this.kind = kind; // "trending" or "search"
        this.payload = payload || {};
        this.page = 0;
        this.nextPage();
    }
    nextPage() {
        this.page++;
        const url = BASE_URL + "/api/videos/" + this.kind + buildQuery(
            Object.assign({}, this.payload, { index: this.page, limit: 50 })
        );
        const data = jsonGETNoThrow(url);
        if (!data) { this.hasMore = false; this.results = []; return this; }
        if (data.success === false) { this.hasMore = false; this.results = []; return this; }
        const list = data.videos || data.data || [];
        this.results = list.map(toPlatformVideo);
        this.hasMore = this.results.length >= 50;
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
        this.nextPage();
    }
    nextPage() {
        this.page++;
        const url = BASE_URL + "/api/playlists/search" + buildQuery({
            q: this.query, index: this.page, limit: 20
        });
        const data = jsonGETNoThrow(url);
        const list = (data && data.data) || [];
        this.results = list.map(p => {
            const ownerName = p.ownerUsername || "";
            const author = ownerName
                ? new PlatformAuthorLink(
                    new PlatformID(PLATFORM, ownerName, config.id),
                    ownerName,
                    channelUrlFromUsername(ownerName),
                    ""
                  )
                : new PlatformAuthorLink(new PlatformID(PLATFORM, "", config.id), "", "", "");
            return new PlatformPlaylist({
                id: new PlatformID(PLATFORM, p._id, config.id),
                name: p.name || "Playlist",
                thumbnail: p.thumbnailUrl || "",
                author: author,
                datetime: parseDateSeconds(p.createdAt),
                url: playlistUrlFromId(p._id),
                videoCount: p.videoCount || 0
            });
        });
        this.hasMore = this.results.length >= 20;
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
