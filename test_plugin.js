// Test harness for the HV-GJ Grayjay plugin.
// Mocks the Grayjay runtime (http, DOM, exception, classes) and runs the
// plugin against the live pmvhaven.com API.

const https = require("https");
const url = require("url");
const fs = require("fs");
const path = require("path");

// ---------- mock Grayjay runtime ----------

global.log = (...a) => { if (process.env.VERBOSE) console.error("[log]", ...a); };

global.ScriptException = class ScriptException extends Error {
    constructor(msg) { super(msg); this.name = "ScriptException"; }
};

let _cookieJar = {}; // domain -> {name:value}

function _setCookieFromHeader(domain, setCookieHeader) {
    if (!setCookieHeader) return;
    const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    arr.forEach(h => {
        const first = h.split(";")[0];
        const eq = first.indexOf("=");
        if (eq <= 0) return;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        _cookieJar[domain] = _cookieJar[domain] || {};
        _cookieJar[domain][name] = value;
    });
}

function _getCookieString(domain) {
    const j = _cookieJar[domain] || {};
    return Object.keys(j).map(k => `${k}=${j[k]}`).join("; ");
}

function _request(method, u, headers, body, useAuth) {
    return new Promise((resolve) => {
        const parsed = url.parse(u);
        const reqHeaders = Object.assign({}, headers || {});
        if (useAuth) {
            const cookies = _getCookieString(parsed.hostname);
            if (cookies) reqHeaders["Cookie"] = cookies;
        }
        const opts = {
            method: method,
            hostname: parsed.hostname,
            path: parsed.path,
            headers: reqHeaders,
            timeout: 30000
        };
        const req = https.request(opts, (res) => {
            let chunks = [];
            res.on("data", c => chunks.push(c));
            res.on("end", () => {
                _setCookieFromHeader(parsed.hostname, res.headers["set-cookie"]);
                const buf = Buffer.concat(chunks).toString("utf8");
                resolve({ isOk: res.statusCode >= 200 && res.statusCode < 300, code: res.statusCode, body: buf });
            });
        });
        req.on("error", e => resolve({ isOk: false, code: 0, body: "", error: e.message }));
        req.on("timeout", () => { req.destroy(); resolve({ isOk: false, code: 0, body: "", error: "timeout" }); });
        if (body) req.write(body);
        req.end();
    });
}

// Synchronous-style http like Grayjay uses (using deasync-style with shell helper).
// We'll instead do a simple busy-wait via deasync substitute: spawn sync request via curl.
const { spawnSync } = require("child_process");

function syncRequest(method, u, headers, body, useAuth) {
    const args = ["-s", "-X", method, "--max-time", "30", u, "-D", "/tmp/_hdrs.txt", "-o", "/tmp/_body.bin", "-w", "%{http_code}"];
    if (headers) {
        Object.keys(headers).forEach(k => { args.push("-H", `${k}: ${headers[k]}`); });
    }
    if (useAuth) {
        const parsed = url.parse(u);
        const cookies = _getCookieString(parsed.hostname);
        if (cookies) args.push("-H", `Cookie: ${cookies}`);
    }
    if (body) args.push("--data", body);
    const r = spawnSync("curl", args, { encoding: "utf8" });
    const code = parseInt(r.stdout || "0", 10) || 0;
    const buf = fs.existsSync("/tmp/_body.bin") ? fs.readFileSync("/tmp/_body.bin", "utf8") : "";
    // Parse Set-Cookie from headers
    try {
        const hdrs = fs.readFileSync("/tmp/_hdrs.txt", "utf8");
        const lines = hdrs.split(/\r?\n/);
        const setCookies = lines.filter(l => /^set-cookie:/i.test(l)).map(l => l.replace(/^set-cookie:\s*/i, ""));
        const parsed = url.parse(u);
        _setCookieFromHeader(parsed.hostname, setCookies);
    } catch (e) { /* ignore */ }
    return { isOk: code >= 200 && code < 300, code: code, body: buf };
}

global.http = {
    GET: (u, headers, useAuth) => syncRequest("GET", u, headers, null, useAuth),
    POST: (u, body, headers, useAuth) => syncRequest("POST", u, headers, body, useAuth),
    PUT: (u, body, headers, useAuth) => syncRequest("PUT", u, headers, body, useAuth),
    DELETE: (u, headers, useAuth) => syncRequest("DELETE", u, headers, null, useAuth),
    clearCookies: (domain) => { delete _cookieJar[domain]; }
};

global.bridge = undefined;

// ---------- mock Grayjay types ----------

class _Base { constructor(o) { Object.assign(this, o || {}); } }
global.PlatformID = class extends _Base { constructor(p, id, plug, ct) { super({ platform: p, value: id, pluginId: plug, claimType: ct }); } };
global.PlatformAuthorLink = class extends _Base {
    constructor(id, name, url, thumbnail, subscribers) { super({ id, name, url, thumbnail, subscribers }); }
};
global.Thumbnail = class extends _Base { constructor(u, q) { super({ url: u, quality: q }); } };
global.Thumbnails = class extends _Base { constructor(list) { super({ sources: list || [] }); } };
global.PlatformVideo = class extends _Base { constructor(o) { super(o); this.contentType = "video"; } };
global.PlatformVideoDetails = class extends global.PlatformVideo { constructor(o) { super(o); } };
global.PlatformChannel = class extends _Base { constructor(o) { super(o); } };
global.PlatformPlaylist = class extends _Base { constructor(o) { super(o); } };
global.PlatformPlaylistDetails = class extends global.PlatformPlaylist { constructor(o) { super(o); } };
global.VideoSourceDescriptor = class extends _Base { constructor(list) { super({ videoSources: list || [] }); } };
global.VideoUrlSource = class extends _Base { constructor(o) { super(o); } };
global.HLSSource = class extends _Base { constructor(o) { super(o); } };
global.RatingLikes = class extends _Base { constructor(l) { super({ likes: l, type: 1 }); } };
global.RatingLikesDislikes = class extends _Base { constructor(l, d) { super({ likes: l, dislikes: d, type: 2 }); } };
global.Comment = class extends _Base { constructor(o) { super(o); } };

global.ContentPager = class { constructor(results, hasMore) { this.results = results || []; this.hasMore = !!hasMore; } hasMorePagers() { return this.hasMore; } nextPage() { return this; } };
global.VideoPager = class extends global.ContentPager { };
global.ChannelPager = class extends global.ContentPager { };
global.PlaylistPager = class extends global.ContentPager { };
global.CommentPager = class extends global.ContentPager { };

global.Type = {
    Feed: { Mixed: "MIXED", Videos: "VIDEOS", Channels: "CHANNELS", Playlists: "PLAYLISTS" },
    Order: { Chronological: "CHRONO" }
};

global.source = {};

// ---------- load plugin ----------

const scriptPath = path.join(__dirname, "script.js");
const code = fs.readFileSync(scriptPath, "utf8");
// eslint-disable-next-line no-new-func
const fn = new Function(code + "\n;return {source:source};");
const exported = fn();

// ---------- tests ----------

const results = [];
function test(name, fn) {
    try {
        const r = fn();
        if (r && r.then) {
            results.push({ name, ok: false, msg: "async tests not supported" });
            return;
        }
        results.push({ name, ok: true, info: r });
        console.log(`✅ ${name}: ${r}`);
    } catch (e) {
        results.push({ name, ok: false, msg: String(e && e.message || e) });
        console.log(`❌ ${name}: ${e && e.message || e}`);
    }
}

// Initialize the plugin
source.enable({ id: "03fb92a4-f857-4f45-a7bf-00c1660e75cb" }, { syncRemoteHistory: false }, null);

test("getHome returns videos", () => {
    const pager = source.getHome();
    if (!pager.results || pager.results.length === 0) throw new Error("no videos");
    const v = pager.results[0];
    if (!v.name) throw new Error("no name");
    if (!v.author || !v.author.name) throw new Error("no author");
    if (!v.url || !v.url.includes("/video/")) throw new Error("bad url: " + v.url);
    return `${pager.results.length} videos, first by "${v.author.name}" "${v.name.slice(0,40)}"`;
});

test("search by query returns videos", () => {
    const pager = source.search("hypno", "MIXED", null, null);
    if (!pager.results || pager.results.length === 0) throw new Error("no results");
    return `${pager.results.length} videos`;
});

test("isContentDetailsUrl recognizes video URL", () => {
    const ok = source.isContentDetailsUrl("https://pmvhaven.com/video/Foo-Bar_6a15e622da44ec6ac850042e");
    if (!ok) throw new Error("did not recognize");
    return "yes";
});

test("getContentDetails returns full video", () => {
    const d = source.getContentDetails("https://pmvhaven.com/video/Lesson-1-Intro_6a15e622da44ec6ac850042e");
    if (!d.name) throw new Error("no name");
    if (!d.video || !d.video.videoSources || d.video.videoSources.length === 0) throw new Error("no sources");
    if (!d.author || !d.author.name) throw new Error("no author");
    return `"${d.name.slice(0,30)}" by ${d.author.name}, ${d.video.videoSources.length} sources, ${d.duration}s`;
});

test("getContentRecommendations returns videos", () => {
    const pager = source.getContentRecommendations("https://pmvhaven.com/video/x_6a15e622da44ec6ac850042e");
    if (!pager.results || pager.results.length === 0) throw new Error("no recs");
    return `${pager.results.length} recommendations`;
});

test("getComments returns comments", () => {
    const pager = source.getComments("https://pmvhaven.com/video/x_6a15e622da44ec6ac850042e");
    if (!pager.results) throw new Error("null");
    if (pager.results.length === 0) throw new Error("no comments");
    const c = pager.results[0];
    if (!c.message) throw new Error("no message");
    return `${pager.results.length} comments, first by ${c.author && c.author.name}`;
});

test("isChannelUrl recognizes profile URL", () => {
    if (!source.isChannelUrl("https://pmvhaven.com/profile/GoonIndoctrination")) throw new Error("missed");
    return "yes";
});

test("getChannel returns profile with banner & subs", () => {
    const ch = source.getChannel("https://pmvhaven.com/profile/GoonIndoctrination");
    if (!ch.name) throw new Error("no name");
    if (!ch.thumbnail) throw new Error("no avatar");
    if (!ch.banner) throw new Error("no banner");
    if (typeof ch.subscribers !== "number") throw new Error("no subs");
    return `${ch.name} (${ch.subscribers} subs, banner=${!!ch.banner})`;
});

test("getChannelContents lists uploader videos", () => {
    const pager = source.getChannelContents("https://pmvhaven.com/profile/GoonIndoctrination");
    if (!pager.results || pager.results.length === 0) throw new Error("no videos");
    return `${pager.results.length} videos`;
});

test("searchChannels returns users", () => {
    const pager = source.searchChannels("Goon");
    if (!pager.results || pager.results.length === 0) throw new Error("no users");
    return `${pager.results.length} channels, first: ${pager.results[0].name}`;
});

test("searchPlaylists returns playlists", () => {
    const pager = source.searchPlaylists("hypno");
    if (!pager.results || pager.results.length === 0) throw new Error("no playlists");
    const p = pager.results[0];
    if (!p.url || !/\/playlists\//.test(p.url)) throw new Error("bad url: " + p.url);
    return `${pager.results.length} playlists, first: "${p.name}" by ${p.author && p.author.name}`;
});

test("search with type=Playlists routes to playlists", () => {
    const pager = source.search("hypno", "PLAYLISTS", null, null);
    if (!pager.results || pager.results.length === 0) throw new Error("no playlists from search");
    return `${pager.results.length} playlists`;
});

test("search with type=Channels routes to channels", () => {
    const pager = source.search("Goon", "CHANNELS", null, null);
    if (!pager.results || pager.results.length === 0) throw new Error("no channels from search");
    return `${pager.results.length} channels`;
});

test("isPlaylistUrl recognizes playlist URL", () => {
    if (!source.isPlaylistUrl("https://pmvhaven.com/playlists/6a1604d705c6e7ff30ce6532")) throw new Error("missed");
    return "yes";
});

test("getPlaylist returns playlist details", () => {
    const d = source.getPlaylist("https://pmvhaven.com/playlists/6a1604d705c6e7ff30ce6532");
    if (!d.name) throw new Error("no name");
    if (!d.contents || !d.contents.results || d.contents.results.length === 0) throw new Error("no videos");
    return `"${d.name}" with ${d.contents.results.length} videos`;
});

test("isLoggedIn returns false when not logged in", () => {
    const r = source.isLoggedIn();
    if (r) throw new Error("should be false");
    return "false (expected)";
});

test("getUserSubscriptions returns [] when not logged in", () => {
    const subs = source.getUserSubscriptions();
    if (!Array.isArray(subs)) throw new Error("not array");
    if (subs.length !== 0) throw new Error("not empty");
    return "[]";
});

test("getUserPlaylists returns [] when not logged in", () => {
    const pls = source.getUserPlaylists();
    if (!Array.isArray(pls)) throw new Error("not array");
    if (pls.length !== 0) throw new Error("not empty");
    return "[]";
});

test("getSearchCapabilities exposes sort + Date/Duration/Quality filters", () => {
    const caps = source.getSearchCapabilities();
    if (!caps.sorts || caps.sorts.indexOf("Newest") < 0) throw new Error("missing Newest sort");
    if (!caps.sorts || caps.sorts.indexOf("Most Liked") < 0) throw new Error("missing Most Liked sort");
    const ids = (caps.filters || []).map(f => f.id);
    ["date", "duration", "quality"].forEach(n => {
        if (ids.indexOf(n) < 0) throw new Error("missing filter id: " + n);
    });
    return `sorts=${caps.sorts.length}, filter ids=${ids.join(",")}`;
});

test("getContentDetails attaches getContentRecommendations on the details object", () => {
    const d = source.getContentDetails("https://pmvhaven.com/video/Lesson-1-Intro_6a15e622da44ec6ac850042e");
    if (typeof d.getContentRecommendations !== "function") throw new Error("missing details.getContentRecommendations");
    const recPager = d.getContentRecommendations();
    if (!recPager.results || recPager.results.length === 0) throw new Error("recs empty via details hook");
    return `${recPager.results.length} recs via details.getContentRecommendations()`;
});

test("search with sort=Newest hits sort=-uploadDate", () => {
    const pager = source.search("hypno", "MIXED", "Newest", null);
    if (!pager.results || pager.results.length === 0) throw new Error("no results");
    const cutoff = Math.floor(Date.now() / 1000) - 60 * 24 * 3600;
    const sample = pager.results.slice(0, 5);
    const recent = sample.filter(v => v.datetime >= cutoff).length;
    if (recent === 0) throw new Error("nothing recent in Newest sort");
    return `${pager.results.length} videos, ${recent}/5 recent`;
});

test("search filters use array values (Grayjay format) — Duration=[20+]", () => {
    const pager = source.search("hypno", "MIXED", null, { duration: ["20+"] });
    if (!pager.results || pager.results.length === 0) throw new Error("no results");
    const short = pager.results.filter(v => v.duration < 20 * 60).length;
    if (short > 0) throw new Error(`${short} videos shorter than 20min leaked through`);
    return `${pager.results.length} videos, all ≥ 20min`;
});

test("search filters Quality=[FHD] returns 1080p+ videos", () => {
    const pager = source.search("hypno", "MIXED", null, { quality: ["FHD"] });
    if (!pager.results || pager.results.length === 0) throw new Error("no results");
    return `${pager.results.length} videos`;
});

test("search filters date=[7days] applies uploadDateFrom", () => {
    const pager = source.search("hypno", "MIXED", null, { date: ["7days"] });
    if (!pager.results) throw new Error("null");
    return `${pager.results.length} videos`;
});

test("getSearchCapabilities exposes Grayjay-shaped filters (id + isMultiSelect)", () => {
    const caps = source.getSearchCapabilities();
    const f = caps.filters;
    if (!Array.isArray(f) || f.length !== 3) throw new Error("expected 3 filter groups");
    const ids = f.map(x => x.id).sort();
    if (ids.join(",") !== "date,duration,quality") throw new Error("bad filter ids: " + ids);
    f.forEach(g => {
        if (typeof g.isMultiSelect === "undefined") throw new Error("missing isMultiSelect on " + g.id);
        if (!Array.isArray(g.filters)) throw new Error("missing filters array on " + g.id);
        g.filters.forEach(opt => {
            if (typeof opt.name !== "string" || typeof opt.value !== "string") {
                throw new Error("bad option in " + g.id);
            }
        });
    });
    return `OK (${f.map(x => x.id).join(",")})`;
});

test("source.login() always returns true (no 'cancelled' in Grayjay)", () => {
    const r = source.login();
    if (r !== true) throw new Error("login must return true so Grayjay does not say 'cancelled'");
    return "true";
});

test("actionLike returns false (no auth) without throwing", () => {
    const r = source.actionLike("https://pmvhaven.com/video/x_6a15e622da44ec6ac850042e", true);
    if (r !== false) throw new Error("should be false when not logged in");
    return "false";
});

test("actionDislike returns false (no auth) without throwing", () => {
    const r = source.actionDislike("https://pmvhaven.com/video/x_6a15e622da44ec6ac850042e", true);
    if (r !== false) throw new Error("should be false when not logged in");
    return "false";
});

test("actionSubscribe returns false (no auth) without throwing", () => {
    const r = source.actionSubscribe("https://pmvhaven.com/profile/GoonIndoctrination", true);
    if (r !== false) throw new Error("should be false when not logged in");
    return "false";
});

test("savePlaybackState returns false when not logged in", () => {
    const r = source.savePlaybackState("https://pmvhaven.com/video/x_6a15e622da44ec6ac850042e", 42);
    if (r !== false) throw new Error("should be false");
    return "false";
});

test("comment pager hasMore reflects API pagination", () => {
    // The video used has only 3 comments → no next page
    const pager = source.getComments("https://pmvhaven.com/video/x_6a15e622da44ec6ac850042e");
    if (pager.results.length === 0) throw new Error("no comments");
    if (pager.hasMore !== false) throw new Error("hasMore should be false on small set");
    return "hasMore=false (correct)";
});

console.log("\n=== Summary ===");
const failed = results.filter(r => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
    failed.forEach(f => console.log(`  FAIL ${f.name}: ${f.msg}`));
    process.exit(1);
}
