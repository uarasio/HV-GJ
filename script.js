const PLATFORM = "Hypnotube";

var config = {};
var settings = {};
//Source Methods
source.enable = function (conf, sett, savedState) {
  config = conf ?? {};
  settings = sett ?? {};
};

source.setSettings = function(newsettings) {
	settings = newsettings;
}


source.getHome = function () {
  return new FeedPager("trending", {
    period: "24h"
  });
};

source.searchSuggestions = function (query) {
  return [];
};
source.getSearchCapabilities = () => {
  return {
    types: [Type.Feed.Mixed],
    sorts: [Type.Order.Chronological],
    filters: [],
  };
};
source.search = function (query, type, order, filters) {
  return new FeedPager("search", {
    q: query,
  });
};
//Video
/**
 *
 * @param {string} url
 * @returns
 */
source.isContentDetailsUrl = function (url) {
  return url.startsWith("https://pmvhaven.com/video/");
};
source.getContentDetails = function (url) {
  return new HVideo(url);
};
/**
 *
 * @param {any} data
 * @param {string[]} path
 * @param {number} index
 * @returns any
 */
function parseNUXT(data, path, index=0) {
  const curr=data[index];
  const target=path[0];
  log("Parsing with path "+JSON.stringify(path)+" and index "+index);
  if(curr[0]=='ShallowReactive'){
    log("ShallowReactive");
    return parseNUXT(data, path, curr[1]);
  }
  if(Array.isArray(curr)){
    if(curr.length==1){
      log("Tiny Array");
      return parseNUXT(data, path, curr[0]);
    }
    throw new ScriptException("Array has more than one element :" + curr.length);
  }
  if (typeof curr == "object"){
    if(path.length==0){
      log("Found object");
      return index;
    }
    const keys=Object.keys(curr);
    if (keys.length==1){
      log("Following single key in path "+path);
      return parseNUXT(data, path, curr[keys[0]])
    }
    for(const key of Object.keys(curr)){
      if(key==target){
        if(path.length==1){
          log("Found key "+key);
          return parseNUXT(data, [], curr[key]);
        }
        log("Found key "+key+" in path "+path);
        return parseNUXT(data, path.slice(1), curr[key]);
      }
    }
  }

  throw new ScriptException("Could not find key '"+target+"' in "+JSON.stringify(curr));
}

class HVideo extends PlatformVideoDetails {
  constructor(url) {
    let res = http.GET(url, {}, false);
    if (!res.isOk) {
      throw new ScriptException("Error trying to load '" + url + "'");
    }
    let dom = domParser.parseFromString(res.body);
    let data=dom.querySelector("script#__NUXT_DATA__").text;
    log("GOT DATA: "+data);
    const json = JSON.parse(data);
    let index=-1;
    for(let i=0;i<json.length;i++){
      if(typeof json[i]!=="object" || !json[i])continue;
      if(Object.keys(json[i]).includes("video")){
        index=json[i]["video"];
      }
    }
    if(index==-1){
      throw new ScriptException("Could not find video data in page");
    }

    const videoindex=index;
    //log("GOT VIDEOINDEX: "+JSON.stringify(videoindex));
    const videoobject=json[videoindex];
    log("GOT VIDEOOBJECT: "+JSON.stringify(videoobject));
    const title=json[videoobject.title];
    log("GOT TITLE: "+title);
    const rawtitle=json[videoobject.title];
    const description=json[videoobject.description];
    log("GOT DESCRIPTION: "+description);
    const thumbnail=json[videoobject.thumbnailUrl];
    log("GOT THUMBNAIL: "+JSON.stringify(thumbnail));

    const vidurl=json[videoobject.videoUrl];
    log("GOT VIDURL: "+vidurl);

    const id=json[videoobject._id];
    log("GOT ID: "+id);
    // let vidurl=dom.querySelector("source").getAttribute("src");
    // let vidname=dom.querySelector(".align-center .pl-2").text;
    log(json.url);
    super({
      id: new PlatformID(PLATFORM, url, config.id),
      name: title,
      thumbnails: new Thumbnails([new Thumbnail(thumbnail, 720)]),
      url: url,
      isLive: false,
      description: description,
      video: new VideoSourceDescriptor([
        new VideoUrlSource({
          container: "video/mp4",
          name: "mp4",
          url: vidurl,
        })
      ]),
    });
    this.data= {
      id: id,
      title: rawtitle,
    };
  }

  // getContentRecommendations() {
  //   let res2=http.POST("https://pmvhaven.com/api/v2/videoInput", JSON.stringify({
  //     mode: "getRecommended",
  //     profile: null,
  //     video: {
  //       _id: this.data.id,
  //       title: this.data.title,
  //     },
  //   }),{}, false);
  //   if (!res2.isOk) {
  //     throw new ScriptException("Error trying to load 'https://pmvhaven.com/api/v2/videoInput'");
  //   }
  //   const json2 = JSON.parse(res2.body);
  //   if (!json2.recommendedVideos){
  //     return;
  //   }
  //   this.recvids = json2.recommendedVideos.map((a)=>toVideo(a));
  //   return new ContentPager(this.recvids, false);
  // }
}
source.getContentRecommendations = (url, initialData) => {
  throw new ScriptException("getContentRecommendations");
};

//Comments
source.getComments = function (url) {
  return new CommentPager(
    [
    ],
    false
  );
};
source.getSubComments = function (comment) {
  throw new ScriptException("This is a sample");
};
/*
param=Record<string,string>
*/
function formatURLQuery(url, param) {
  const urlObj = new URL(url);
  for (const key in param) {
    urlObj.searchParams.set(key, param[key]);
  }
  return urlObj.toString();
}

class FeedPager extends ContentPager {
  constructor(type,payload) {
    super([], true);
    this.type = type;
    this.payload = payload;
    this.page = 0;
    this.nextPage();
  }
  nextPage() {
    this.page++;
    const obj= {
      ...this.payload,
      index: this.page,
      limit: 50,
    }
    let res = undefined;
    res = http.GET(formatURLQuery("https://pmvhaven.com/api/videos/" + this.type, obj),{}, false);

    if (!res.isOk) {
      throw new ScriptException("Error trying to load '" + "https://pmvhaven.com/api/v2/search" + "'");
    }
    const json = JSON.parse(res.body);
    if (!json.success){
      this.hasMore = false;
      this.results = [];
      return this;
    }
    const out=json.videos.map((a)=>toVideo(a));
    this.results = out;
    return this;
  }
}


function toVideo(a) {
  // const fakeurl=JSON.stringify({
  //   type: "pmvhaven",
  //   url: a.url,
  //   title: a.title,
  //   description: a.description,
  //   thumbnails: a.thumbnails.filter((b)=>b!="placeholder"),
  //   obj:a,
  // });
  log(JSON.stringify(a));
  const titleid=a.title.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
  const vidid=titleid+"_"+a._id;
  const vidurl="https://pmvhaven.com/video/"+vidid;
return new PlatformVideo({
  id: new PlatformID(
    "PMVHaven",
    vidurl,
    config.id
  ),
  name: a.title,
  thumbnails: a.thumbnailUrl===undefined?undefined:new Thumbnails([new Thumbnail(a.thumbnailUrl, 720)]),
  //   author: new PlatformAuthorLink(
  //     new PlatformID("SomePlatformName", "SomeAuthorID", config.id),
  //     "SomeAuthorName",
  //     "https://platform.com/your/channel/url",
  //     "../url/to/thumbnail.png"
  //   ),
  //   uploadDate: 1696880568,
  duration: parseDuration(a.duration),
  viewCount: a.views,
  url: vidurl,
  isLive: false,
});
}

function parseDuration(duration) {
  if (typeof duration === "number") {
    return duration;
  }
  if (typeof duration === "string") {
    const parts = duration.split(":").map((a) => parseInt(a));
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
  }
  return undefined;
}
log("LOADED");
