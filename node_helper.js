"use strict";

const NodeHelper = require("node_helper");
const crypto = require("crypto");
const { createSource } = require("./wallpaper_sources");

const UNSPLASH_REQUEST_WINDOW_MS = 60 * 60 * 1000;
const UNSPLASH_REQUEST_LIMIT = 45;
const UNSPLASH_REMAINING_BUFFER = 5;

module.exports = NodeHelper.create({
  start() {
    console.log(`Starting node helper for: ${this.name}`);
    this.sources = {};
    this.unsplashUsage = new Map();
    this.expressApp.use(`/${this.name}/images/`, this.requestHandler.bind(this));
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "FETCH_WALLPAPERS") {
      this.fetchWallpapers(payload);
    }
  },

  getUnsplashUsage(apiKey) {
    const key = crypto.createHash("sha256").update(apiKey).digest("hex");
    if (!this.unsplashUsage.has(key)) {
      this.unsplashUsage.set(key, {
        requestTimes: [],
        blockedUntil: 0,
        warningLogged: false,
        inFlight: false
      });
    }

    return this.unsplashUsage.get(key);
  },

  allowUnsplashRequest(apiKey) {
    const usage = this.getUnsplashUsage(apiKey);
    const now = Date.now();
    usage.requestTimes = usage.requestTimes.filter(time => now - time < UNSPLASH_REQUEST_WINDOW_MS);

    if (usage.inFlight) {
      return false;
    }

    let reason = null;
    if (usage.blockedUntil > now) {
      reason = "Unsplash reports a low remaining request limit";
    } else if (usage.requestTimes.length >= UNSPLASH_REQUEST_LIMIT) {
      reason = "the local hourly request budget is exhausted";
    }

    if (reason) {
      if (!usage.warningLogged) {
        console.warn(`MMM-Wallpaper: skipping Unsplash refreshes because ${reason}`);
        usage.warningLogged = true;
      }
      return false;
    }

    usage.requestTimes.push(now);
    usage.warningLogged = false;
    usage.inFlight = true;
    return true;
  },

  finishUnsplashRequest(apiKey) {
    this.getUnsplashUsage(apiKey).inFlight = false;
  },

  observeUnsplashRateLimit(apiKey, remaining) {
    if (remaining === null || typeof remaining === "undefined" || remaining === "") {
      return;
    }

    const remainingRequests = Number(remaining);
    if (!Number.isFinite(remainingRequests) || remainingRequests > UNSPLASH_REMAINING_BUFFER) {
      return;
    }

    const usage = this.getUnsplashUsage(apiKey);
    usage.blockedUntil = Math.max(usage.blockedUntil, Date.now() + UNSPLASH_REQUEST_WINDOW_MS);
  },

  fetchWallpapers(config) {
    if (Array.isArray(config.source)) {
      config.source = config.source[Math.floor(Math.random() * config.source.length)];
    }

    let sourceKey = `${config.source}::${config.orientation}`;
    if (config.source.toLowerCase() === "unsplash") {
      sourceKey += `::${JSON.stringify([
        config.unsplashAPIKey,
        config.unsplashQuery,
        config.unsplashCollectionIDs,
        config.unsplashUserName,
        config.unsplashPhotoID
      ])}`;
    }

    const id = crypto.createHash("sha1").update(sourceKey).digest("hex");
    if (!(id in this.sources)) {
      this.sources[id] = createSource(this, config, id);
    }

    this.sources[id].refresh();
  },

  requestHandler(request, response) {
    const id = request.url.split("/")[1];

    if (id in this.sources) {
      const source = this.sources[id];
      if (source.requestHandler !== null) {
        request.url = request.url.substring(id.length + 1);
        return source.requestHandler(request, response);
      }
    }

    response.sendStatus(404);
  },

  onSourceUpdated(source) {
    let images = source.imageCache.images.slice(0, source.config.maximumEntries).map(image => ({...image}));
    if (source.requestHandler !== null) {
      const urlPath = `/${this.name}/images/${source.id}/`;
      for (const image of images) {
        image.url = `${urlPath}${image.url.replace(/^\/+/, "")}`;
      }
    }

    const notification = {
      source: source.config.source,
      orientation: source.config.orientation,
      images: images,
    };
    if (source.config.source.toLowerCase() === "unsplash") {
      notification.unsplashQuery = source.config.unsplashQuery;
    }

    this.sendSocketNotification("WALLPAPERS", notification);
  },
});
