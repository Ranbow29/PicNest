"use strict";
const electron = require("electron");
const api = {
  getPaths: () => electron.ipcRenderer.invoke("get-paths"),
  getFilePath: (file) => {
    try {
      return electron.webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  resolveDropPaths: (paths) => electron.ipcRenderer.invoke("resolve-drop-paths", paths),
  setNewFoldersDir: () => electron.ipcRenderer.invoke("set-new-folders-dir"),
  scanFolder: (folderPath, sortMode, forceShuffle, hueOrigin) => electron.ipcRenderer.invoke("scan-folder", folderPath, sortMode, forceShuffle, hueOrigin),
  getImagesPage: (folderId, offset, limit, sortMode) => electron.ipcRenderer.invoke("get-images-page", folderId, offset, limit, sortMode),
  getImagesCount: (folderId) => electron.ipcRenderer.invoke("get-images-count", folderId),
  getImagesPageMulti: (folderIds, offset, limit, sortMode) => electron.ipcRenderer.invoke("get-images-page-multi", folderIds, offset, limit, sortMode),
  getImagesCountMulti: (folderIds) => electron.ipcRenderer.invoke("get-images-count-multi", folderIds),
  searchImages: (folderId, query, offset, limit) => electron.ipcRenderer.invoke("search-images", folderId, query, offset, limit),
  searchImagesCount: (folderId, query) => electron.ipcRenderer.invoke("search-images-count", folderId, query),
  // 描述搜索
  searchByDescription: (folderId, query, offset, limit) => electron.ipcRenderer.invoke("search-by-description", folderId, query, offset, limit),
  searchByDescriptionCount: (folderId, query) => electron.ipcRenderer.invoke("search-by-description-count", folderId, query),
  // 评分搜索
  searchByRating: (folderId, ratings, offset, limit) => electron.ipcRenderer.invoke("search-by-rating", folderId, ratings, offset, limit),
  searchByRatingCount: (folderId, ratings) => electron.ipcRenderer.invoke("search-by-rating-count", folderId, ratings),
  // 宽高比搜索
  searchByAspectRatio: (folderId, ratioW, ratioH, tolerance, offset, limit) => electron.ipcRenderer.invoke("search-by-aspect-ratio", folderId, ratioW, ratioH, tolerance, offset, limit),
  searchByAspectRatioCount: (folderId, ratioW, ratioH, tolerance) => electron.ipcRenderer.invoke("search-by-aspect-ratio-count", folderId, ratioW, ratioH, tolerance),
  // 多文件夹搜索
  searchImagesMulti: (folderIds, query, offset, limit, sortMode) => electron.ipcRenderer.invoke("search-images-multi", folderIds, query, offset, limit, sortMode),
  searchImagesCountMulti: (folderIds, query) => electron.ipcRenderer.invoke("search-images-count-multi", folderIds, query),
  searchByDescriptionMulti: (folderIds, query, offset, limit, sortMode) => electron.ipcRenderer.invoke("search-by-description-multi", folderIds, query, offset, limit, sortMode),
  searchByDescriptionCountMulti: (folderIds, query) => electron.ipcRenderer.invoke("search-by-description-count-multi", folderIds, query),
  searchByRatingMulti: (folderIds, ratings, offset, limit, sortMode) => electron.ipcRenderer.invoke("search-by-rating-multi", folderIds, ratings, offset, limit, sortMode),
  searchByRatingCountMulti: (folderIds, ratings) => electron.ipcRenderer.invoke("search-by-rating-count-multi", folderIds, ratings),
  searchByAspectRatioMulti: (folderIds, ratioW, ratioH, tolerance, offset, limit, sortMode) => electron.ipcRenderer.invoke("search-by-aspect-ratio-multi", folderIds, ratioW, ratioH, tolerance, offset, limit, sortMode),
  searchByAspectRatioCountMulti: (folderIds, ratioW, ratioH, tolerance) => electron.ipcRenderer.invoke("search-by-aspect-ratio-count-multi", folderIds, ratioW, ratioH, tolerance),
  // 印象色搜索
  searchByColor: (folderIds, target, tolerance, offset, limit, sortMode, useHue, useSat, useValue) => electron.ipcRenderer.invoke("search-by-color", folderIds, target, tolerance, offset, limit, sortMode, useHue, useSat, useValue),
  // AI 语义搜索（CLIP）
  computeClipBatch: (paths) => electron.ipcRenderer.invoke("compute-clip-batch", paths),
  computeClipFeature: (filePath) => electron.ipcRenderer.invoke("compute-clip-feature", filePath),
  buildClipIndex: (folderId, force) => electron.ipcRenderer.invoke("build-clip-index", folderId, force),
  buildClipIndexMulti: (folderIds, force) => electron.ipcRenderer.invoke("build-clip-index-multi", folderIds, force),
  searchByText: (query, scope, topN) => electron.ipcRenderer.invoke("search-by-text", query, scope, topN),
  clipIndexStatus: (folderId) => electron.ipcRenderer.invoke("clip-index-status", folderId),
  clipIndexStatusMulti: (folderIds) => electron.ipcRenderer.invoke("clip-index-status-multi", folderIds),
  buildColorIndex: (folderId, force) => electron.ipcRenderer.invoke("build-color-index", folderId, force),
  buildColorIndexMulti: (folderIds) => electron.ipcRenderer.invoke("build-color-index-multi", folderIds),
  colorIndexStatus: (folderId) => electron.ipcRenderer.invoke("color-index-status", folderId),
  colorIndexStatusMulti: (folderIds) => electron.ipcRenderer.invoke("color-index-status-multi", folderIds),
  onClipIndexProgress: (cb) => {
    const handler = (_e, p) => {
      try {
        cb(p);
      } catch {
      }
    };
    electron.ipcRenderer.on("clip-index-progress", handler);
    return () => {
      try {
        electron.ipcRenderer.removeListener("clip-index-progress", handler);
      } catch {
      }
    };
  },
  onColorIndexProgress: (cb) => {
    const handler = (_e, p) => {
      try {
        cb(p);
      } catch {
      }
    };
    electron.ipcRenderer.on("color-index-progress", handler);
    return () => {
      try {
        electron.ipcRenderer.removeListener("color-index-progress", handler);
      } catch {
      }
    };
  },
  // 直接返回 IPC 返回 Promise<void>，方便调用方 await 获取结果，不通过 onClipIndexProgress 等事件
  rawBuildClipIndex: (folderId) => electron.ipcRenderer.invoke("build-clip-index", folderId),
  getRandomSample: (folderId, excludePath, count) => electron.ipcRenderer.invoke("get-random-sample", folderId, excludePath, count),
  getAllImageIds: (folderId) => electron.ipcRenderer.invoke("get-all-image-ids", folderId),
  getImagesByIds: (ids) => electron.ipcRenderer.invoke("get-images-by-ids", ids),
  generateThumbnail: (sourcePath) => electron.ipcRenderer.invoke("generate-thumbnail", sourcePath),
  favoriteImage: (sourcePath) => electron.ipcRenderer.invoke("favorite-image", sourcePath),
  unfavoriteImage: (sourcePath) => electron.ipcRenderer.invoke("unfavorite-image", sourcePath),
  setImageRating: (filePath, rating) => electron.ipcRenderer.invoke("set-image-rating", filePath, rating),
  setImageDescription: (filePath, desc) => electron.ipcRenderer.invoke("set-image-description", filePath, desc),
  clearRatingsInFolder: (folderPath) => electron.ipcRenderer.invoke("clear-ratings-in-folder", folderPath),
  clearDescriptionsInFolder: (folderPath) => electron.ipcRenderer.invoke("clear-descriptions-in-folder", folderPath),
  saveAs: (sourcePath) => electron.ipcRenderer.invoke("save-as", sourcePath),
  saveAsBatch: (sourcePaths, destFolder) => electron.ipcRenderer.invoke("save-as-batch", sourcePaths, destFolder),
  deleteImage: (filePath) => electron.ipcRenderer.invoke("delete-image", filePath),
  openInFolder: (filePath) => electron.ipcRenderer.invoke("open-in-folder", filePath),
  openWithDefault: (filePath) => electron.ipcRenderer.invoke("open-with-default", filePath),
  yandexSearch: (filePath) => electron.ipcRenderer.invoke("yandex-search", filePath),
  saucenaoSearch: (filePath) => electron.ipcRenderer.invoke("saucenao-search", filePath),
  tineyeSearch: (filePath) => electron.ipcRenderer.invoke("tineye-search", filePath),
  tracemoeSearch: (filePath) => electron.ipcRenderer.invoke("tracemoe-search", filePath),
  googlelensSearch: (filePath) => electron.ipcRenderer.invoke("googlelens-search", filePath),
  importImagesToFolder: (imgPaths, destFolder) => electron.ipcRenderer.invoke("import-images-to-folder", imgPaths, destFolder),
  copyImageToClipboard: (filePath) => electron.ipcRenderer.invoke("copy-image-to-clipboard", filePath),
  copyFilesToClipboard: (filePaths) => electron.ipcRenderer.invoke("copy-files-to-clipboard", filePaths),
  readClipboardFiles: () => electron.ipcRenderer.invoke("read-clipboard-files"),
  syncFolderSnapshot: (folderPath) => electron.ipcRenderer.invoke("sync-folder-snapshot", folderPath),
  startWatcher: (folderPath) => electron.ipcRenderer.invoke("start-watcher", folderPath),
  stopWatcher: () => electron.ipcRenderer.invoke("stop-watcher"),
  recomputeSortOrder: (folderId, sortMode, forceShuffle, hueOrigin) => electron.ipcRenderer.invoke("recompute-sort-order", folderId, sortMode, forceShuffle, hueOrigin),
  getRandomSeed: (folderId) => electron.ipcRenderer.invoke("get-random-seed", folderId),
  setRandomSeed: (folderId, seed) => electron.ipcRenderer.invoke("set-random-seed", folderId, seed),
  computeFeature: (filePath) => electron.ipcRenderer.invoke("compute-feature", filePath),
  computeFeaturesBatch: (paths) => electron.ipcRenderer.invoke("compute-features-batch", paths),
  getClipFeaturesByPaths: (paths) => electron.ipcRenderer.invoke("get-clip-features-by-paths", paths),
  getColorInfoByPaths: (paths) => electron.ipcRenderer.invoke("get-color-info-by-paths", paths),
  prefetchFeatures: (folderId) => electron.ipcRenderer.invoke("prefetch-features", folderId),
  getAllFeatures: () => electron.ipcRenderer.invoke("get-all-features"),
  selectFolder: () => electron.ipcRenderer.invoke("select-folder"),
  selectFolders: () => electron.ipcRenderer.invoke("select-folders"),
  selectImage: () => electron.ipcRenderer.invoke("select-image"),
  analyzeBgBrightness: (path) => electron.ipcRenderer.invoke("analyze-bg-brightness", path),
  selectCoverImage: (folderPath) => electron.ipcRenderer.invoke("select-cover-image", folderPath),
  dbInitFolder: (folderPath) => electron.ipcRenderer.invoke("db-init-folder", folderPath),
  dbInsertImage: (image) => electron.ipcRenderer.invoke("db-insert-image", image),
  dbDeleteImage: (filePath) => electron.ipcRenderer.invoke("db-delete-image", filePath),
  dbGetImagesByFolder: (folderId) => electron.ipcRenderer.invoke("db-get-images-by-folder", folderId),
  updateImageDimensions: (filePath, width, height) => electron.ipcRenderer.invoke("update-image-dimensions", filePath, width, height),
  updateImageThumbnail: (filePath, thumbnailPath) => electron.ipcRenderer.invoke("update-image-thumbnail", filePath, thumbnailPath),
  getDimensionsBatch: (paths) => electron.ipcRenderer.invoke("get-dimensions-batch", paths),
  fillImageDims: (paths) => electron.ipcRenderer.invoke("fill-image-dims", paths),
  getImageInfo: (filePath) => electron.ipcRenderer.invoke("get-image-info", filePath),
  saveConfig: (config) => electron.ipcRenderer.invoke("save-config", config),
  setZoomFactor: (factor) => {
    try {
      electron.webFrame.setZoomFactor(factor);
    } catch {
    }
  },
  getZoomFactor: () => {
    try {
      return electron.webFrame.getZoomFactor();
    } catch {
      return 1;
    }
  },
  setFormatFilter: (exts) => electron.ipcRenderer.invoke("set-format-filter", exts),
  clearImageCache: () => electron.ipcRenderer.invoke("clear-image-cache"),
  readConfig: () => electron.ipcRenderer.invoke("read-config"),
  loadFavorites: () => electron.ipcRenderer.invoke("load-favorites"),
  generateThumbnailsBatch: (filePaths) => electron.ipcRenderer.invoke("generate-thumbnails-batch", filePaths),
  // F1 图形审计
  getImageMetadata: (filePath) => electron.ipcRenderer.invoke("get-image-metadata", filePath),
  samplePixel: (filePath, x, y) => electron.ipcRenderer.invoke("sample-pixel", filePath, x, y),
  sampleRect: (filePath, x, y, w, h) => electron.ipcRenderer.invoke("sample-rect", filePath, x, y, w, h),
  computeHistogram: (filePath, sampleStep) => electron.ipcRenderer.invoke("compute-histogram", filePath, sampleStep),
  computeColorAnalysis: (filePath) => electron.ipcRenderer.invoke("compute-color-analysis", filePath),
  // pinboards
  getPinboards: () => electron.ipcRenderer.invoke("pinboards-read"),
  createPinboard: (name) => electron.ipcRenderer.invoke("pinboards-create", name),
  setCurrentPinboard: (id) => electron.ipcRenderer.invoke("pinboards-set-current", id),
  deletePinboard: (id) => electron.ipcRenderer.invoke("pinboards-delete", id),
  renamePinboard: (id, name) => electron.ipcRenderer.invoke("pinboards-rename", id, name),
  setPinboardHotkey: (id, hotkey) => electron.ipcRenderer.invoke("pinboards-set-hotkey", id, hotkey),
  reorderPinboards: (orderedIds) => electron.ipcRenderer.invoke("pinboards-reorder", orderedIds),
  clearPinboard: (id) => electron.ipcRenderer.invoke("pinboards-clear", id),
  addImageToPinboard: (id, imagePath) => electron.ipcRenderer.invoke("pinboards-add-image", id, imagePath),
  removeImageFromPinboard: (id, imagePath) => electron.ipcRenderer.invoke("pinboards-remove-image", id, imagePath),
  exportPinboard: (id) => electron.ipcRenderer.invoke("pinboards-export", id),
  exportPinboardToFolder: (id, folderPath) => electron.ipcRenderer.invoke("pinboards-export-to-folder", id, folderPath),
  hasNonemptyPinboards: () => electron.ipcRenderer.invoke("pinboards-has-nonempty"),
  clearAllPinboards: () => electron.ipcRenderer.invoke("pinboards-clear-all"),
  // folder management
  getAllFolders: () => electron.ipcRenderer.invoke("get-all-folders"),
  reorderFolders: (orderedIds) => electron.ipcRenderer.invoke("reorder-folders", orderedIds),
  addFolder: () => electron.ipcRenderer.invoke("add-folder"),
  addFolderByPath: (folderPath) => electron.ipcRenderer.invoke("add-folder-by-path", folderPath),
  getFolderNameByPath: (folderPath) => electron.ipcRenderer.invoke("get-folder-name-by-path", folderPath),
  getFolderRandomThumbs: (folderId, count) => electron.ipcRenderer.invoke("get-folder-random-thumbs", folderId, count),
  addFolderNew: (name) => electron.ipcRenderer.invoke("create-new-folder", name),
  updateFolderName: (id, name) => electron.ipcRenderer.invoke("update-folder-name", id, name),
  updateFolderDescription: (id, desc) => electron.ipcRenderer.invoke("update-folder-description", id, desc),
  updateFolderPath: (id) => electron.ipcRenderer.invoke("update-folder-path", id),
  updateFolderCover: (id, coverPath) => electron.ipcRenderer.invoke("update-folder-cover", id, coverPath),
  toggleFolderFavorite: (id, val) => electron.ipcRenderer.invoke("toggle-folder-favorite", id, val),
  deleteFolder: (id, folderPath) => electron.ipcRenderer.invoke("delete-folder", id, folderPath),
  updateFolderColor: (folderId, color) => electron.ipcRenderer.invoke("update-folder-color", folderId, color),
  getFolderStats: (folderId) => electron.ipcRenderer.invoke("get-folder-stats", folderId),
  getAllFolderStats: () => electron.ipcRenderer.invoke("get-all-folder-stats"),
  getAllFolderGridData: () => electron.ipcRenderer.invoke("get-all-folder-grid-data"),
  preloadFolderStats: () => electron.ipcRenderer.invoke("preload-folder-stats"),
  getDashboardStats: () => electron.ipcRenderer.invoke("get-dashboard-stats"),
  getFavoritesCount: () => electron.ipcRenderer.invoke("get-favorites-count"),
  windowMinimize: () => electron.ipcRenderer.send("window-minimize"),
  windowMaximize: () => electron.ipcRenderer.send("window-maximize"),
  windowClose: () => electron.ipcRenderer.send("window-close"),
  windowIsMaximized: () => electron.ipcRenderer.invoke("window-is-maximized"),
  windowIsAlwaysOnTop: () => electron.ipcRenderer.invoke("window-is-always-on-top"),
  windowToggleAlwaysOnTop: () => electron.ipcRenderer.send("window-toggle-always-on-top"),
  setTitlebarTheme: (isLight) => electron.ipcRenderer.invoke("set-titlebar-theme", isLight),
  onWindowStateChanged: (callback) => {
    electron.ipcRenderer.on("window-state-changed", (_event, isMaximized) => callback(isMaximized));
  },
  onDbSync: (callback) => {
    electron.ipcRenderer.on("sync-db", (_event, data) => callback(data));
  },
  onConfirmClose: (callback) => {
    electron.ipcRenderer.on("confirm-close", () => callback());
  },
  onConfirmOversize: (callback) => {
    electron.ipcRenderer.on("confirm-oversize", () => callback());
  },
  respondOversizeConfirm: (confirmed) => {
    electron.ipcRenderer.send("confirm-oversize-response", confirmed);
  },
  onDropResult: (callback) => {
    electron.ipcRenderer.on("drop-result", (_event, data) => callback(data));
  },
  onShowToast: (callback) => {
    electron.ipcRenderer.on("show-toast", (_event, data) => callback(data));
  },
  respondCloseConfirm: (confirmed) => {
    electron.ipcRenderer.send("confirm-close-response", confirmed);
  },
  readFileBuffer: (filePath) => electron.ipcRenderer.invoke("read-file-buffer", filePath),
  perfProbe: (payload) => electron.ipcRenderer.invoke("perf-probe", payload),
  writeTempPng: (data) => electron.ipcRenderer.invoke("write-temp-png", data),
  openRefBoard: (filePath) => electron.ipcRenderer.invoke("open-ref-board", filePath),
  resetRefCascade: () => electron.ipcRenderer.invoke("reset-ref-cascade"),
  installShellMenu: () => electron.ipcRenderer.invoke("install-shell-menu"),
  uninstallShellMenu: () => electron.ipcRenderer.invoke("uninstall-shell-menu"),
  shellMenuStatus: () => electron.ipcRenderer.invoke("shell-menu-status"),
  getSteamStatus: () => electron.ipcRenderer.invoke("steam-status"),
  openSteamStore: () => electron.ipcRenderer.invoke("open-steam-store")
};
electron.contextBridge.exposeInMainWorld("picrand", api);
if (typeof document !== "undefined") {
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
  }, true);
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (dt && Array.from(dt.types || []).includes("x-picrand/reorder")) {
      return;
    }
    if (!dt) {
      electron.ipcRenderer.send("drop-folders", { paths: [], diag: "no dataTransfer" });
      return;
    }
    const paths = [];
    const errs = [];
    const files = dt.files;
    const fLen = files ? files.length : 0;
    const items = dt.items;
    const iLen = items ? items.length : 0;
    if (files && fLen) {
      for (let i = 0; i < fLen; i++) {
        const f = files[i];
        let p = "";
        try {
          p = electron.webUtils.getPathForFile(f) || "";
        } catch (er) {
          errs.push("f" + i + ":gpf:" + (er?.message || "err"));
        }
        if (!p) try {
          p = f.path || "";
        } catch {
        }
        if (p) paths.push(p);
      }
    }
    const send = () => electron.ipcRenderer.send("drop-folders", { paths, diag: `files=${fLen} items=${iLen} ${errs.join(";")}` });
    if (!paths.length && items && iLen) {
      const pending = [];
      for (let i = 0; i < iLen; i++) {
        let entry = null;
        try {
          entry = items[i].webkitGetAsEntry?.();
        } catch (er) {
          errs.push("i" + i + ":entry:" + (er?.message || "err"));
          continue;
        }
        if (!entry) {
          errs.push("i" + i + ":noEntry");
          continue;
        }
        if (entry.isDirectory) {
          pending.push((async () => {
            try {
              const firstFile = await readFirstFileInDirEntry(entry);
              if (firstFile) {
                let p = "";
                try {
                  p = electron.webUtils.getPathForFile(firstFile) || "";
                } catch {
                }
                if (p) {
                  const dir = p.includes("\\") ? p.split("\\").slice(0, -1).join("\\") : p.split("/").slice(0, -1).join("/");
                  if (dir) paths.push(dir);
                } else errs.push("i" + i + ":dirNoPath");
              } else {
                errs.push("i" + i + ":dirEmpty");
              }
            } catch (er) {
              errs.push("i" + i + ":dirRead:" + (er?.message || "err"));
            }
          })());
        } else if (entry.isFile) {
          errs.push("i" + i + ":isFile");
        } else {
          errs.push("i" + i + ":unknownEntry");
        }
      }
      if (pending.length) {
        Promise.all(pending).then(send);
        return;
      }
    }
    send();
  }, true);
}
function readFirstFileInDirEntry(dirEntry, depth = 0) {
  return new Promise((resolve) => {
    if (depth > 8) {
      resolve(null);
      return;
    }
    const reader = dirEntry.createReader();
    const readBatch = () => {
      reader.readEntries((entries) => {
        if (!entries.length) {
          resolve(null);
          return;
        }
        (async () => {
          for (const ent of entries) {
            if (ent.isFile) {
              try {
                const f = await new Promise((res) => ent.file((file) => res(file), () => res(null)));
                if (f) {
                  resolve(f);
                  return;
                }
              } catch {
              }
            } else if (ent.isDirectory) {
              const f = await readFirstFileInDirEntry(ent, depth + 1);
              if (f) {
                resolve(f);
                return;
              }
            }
          }
          readBatch();
        })();
      }, () => resolve(null));
    };
    readBatch();
  });
}
