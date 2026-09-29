import { api, absoluteMedia } from "../../services/api";

function decode(value?: string): string {
  try { return value ? decodeURIComponent(value) : ""; } catch { return ""; }
}

function saveToAlbum(filePath: string, video = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const save = video ? wx.saveVideoToPhotosAlbum : wx.saveImageToPhotosAlbum;
    save({
      filePath,
      success: () => resolve(),
      fail: (err) => reject(new Error(err.errMsg)),
    });
  });
}

function download(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: (res) =>
        res.statusCode === 200 ? resolve(res.tempFilePath) : reject(new Error("下载失败")),
      fail: (err) => reject(new Error(err.errMsg)),
    });
  });
}

Page({
  data: {
    isVideo: false,
    saving: false,
    src: "",
    title: "",
    publishingCopy: null as string | null,
    tags: null as string | null,
    shareToken: "",
    shared: false,
    loading: false,
    sharing: false,
    error: "",
  },

  sharedToken: "",

  onLoad(query: { src?: string; title?: string; share?: string; type?: string; copy?: string; tags?: string }) {
    wx.hideShareMenu({ menus: ["shareAppMessage", "shareTimeline"] });
    this.sharedToken = query.share || "";
    this.setData({
      src: query.share ? "" : decode(query.src),
      title: query.share ? "" : decode(query.title),
      publishingCopy: !query.share && query.copy !== undefined ? decode(query.copy) : null,
      tags: !query.share ? (query.tags !== undefined ? decode(query.tags) : (decode(query.title).match(/#[^\s#]+/g) || []).join(" ")) : "",
      shared: !!query.share,
      isVideo: !query.share && query.type === "video",
    });
  },

  async onShow() {
    if (this.sharedToken) {
      await this.loadShared();
    } else if (this.data.src) {
      if (!(await getApp().ensureSession())) return;
      try {
        const result = await api.imageShareStatus(this.data.src);
        this.setShareToken(result.token || "");
      } catch {
        this.setShareToken("");
      }
    } else {
      this.setData({ error: "作品不存在或链接不完整" });
    }
  },

  setShareToken(token: string) {
    this.setData({ shareToken: token });
    if (token) wx.showShareMenu({ menus: ["shareAppMessage", "shareTimeline"] });
    else wx.hideShareMenu({ menus: ["shareAppMessage", "shareTimeline"] });
  },

  async loadShared() {
    this.setShareToken("");
    this.setData({ loading: true, error: "", src: "" });
    try {
      const work = await api.sharedImage(this.sharedToken);
      this.setData({ src: absoluteMedia(work.url), title: work.title, tags: (work.title.match(/#[^\s#]+/g) || []).join(" "), isVideo: work.mime === "video/mp4" });
      this.setShareToken(this.sharedToken);
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "作品加载失败，请重试" });
    } finally { this.setData({ loading: false }); }
  },

  async prepareShare() {
    if (!this.data.src || this.data.sharing || this.data.shared) return;
    if (!(await getApp().ensureSession())) return;
    this.setData({ sharing: true });
    try {
      const share = await api.createImageShare(this.data.src, this.data.title);
      if (!this.data.isVideo) this.setData({ title: share.title });
      this.setShareToken(share.token);
      wx.showToast({ title: "卡片已就绪，点击发送", icon: "none" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "分享准备失败", icon: "none" });
    } finally { this.setData({ sharing: false }); }
  },

  revokeShare() {
    if (!this.data.shareToken || this.data.shared || this.data.sharing) return;
    wx.showModal({
      title: "撤销作品分享", content: "撤销后，之前的卡片将无法打开作品。已保存的作品不会被收回。", confirmText: "撤销分享",
      success: async ({ confirm }) => {
        if (!confirm) return;
        this.setData({ sharing: true });
        try {
          await api.revokeImageShare(this.data.shareToken);
          this.setShareToken("");
          wx.showToast({ title: "分享已撤销", icon: "success" });
        } catch { wx.showToast({ title: "撤销失败，请重试", icon: "none" }); }
        finally { this.setData({ sharing: false }); }
      },
    });
  },

  onShareAppMessage() {
    return {
      title: this.data.title || "看看我的创作",
      imageUrl: this.data.isVideo ? undefined : this.data.src || undefined,
      path: `/pages/preview/index?share=${encodeURIComponent(this.data.shareToken)}`,
    };
  },

  onShareTimeline() {
    return { title: this.data.title || "看看我的创作", query: `share=${encodeURIComponent(this.data.shareToken)}`,
      imageUrl: this.data.isVideo ? undefined : this.data.src || undefined };
  },

  async timeline() {
    if (!this.data.shareToken) await this.prepareShare();
    if (!this.data.shareToken) return;
    wx.showModal({ title: "分享到朋友圈", content: "请点击右上角「···」，选择「分享到朋友圈」。也可以保存视频后，在朋友圈选择相册中的视频发布。", showCancel: false });
  },

  copyText() { this.copyPublication("text"); },
  copyTags() { this.copyPublication("tags"); },
  copyPublication(kind: "text" | "tags") {
    const title = this.data.title;
    const value = kind === "text"
      ? this.data.publishingCopy ?? title.replace(/#[^\s#]+/g, "").trim()
      : this.data.tags ?? (title.match(/#[^\s#]+/g) || []).join(" ");
    const label = kind === "text" ? "文案" : "标签";
    if (!value.trim()) {
      wx.showToast({ title: `暂无可复制的${label}`, icon: "none" });
      return;
    }
    wx.setClipboardData({ data: value.trim(),
      success: () => wx.showToast({ title: `${label}已复制`, icon: "success" }),
      fail: () => wx.showToast({ title: "复制失败，请重试", icon: "none" }),
    });
  },

  preview() {
    if (!this.data.src || this.data.isVideo) return;
    wx.previewImage({ urls: [this.data.src], current: this.data.src });
  },

  async save(): Promise<boolean> {
    if (!this.data.src || this.data.saving) return false;
    this.setData({ saving: true });
    wx.showLoading({ title: "保存中", mask: true });
    try {
      const filePath = await download(this.data.src);
      try {
        await saveToAlbum(filePath, this.data.isVideo);
      } catch {
        await new Promise<void>((resolve, reject) => {
          wx.authorize({
            scope: "scope.writePhotosAlbum",
            success: () => resolve(),
            fail: () => reject(new Error("需要相册权限")),
          });
        });
        await saveToAlbum(filePath, this.data.isVideo);
      }
      wx.showToast({ title: "已存进相册", icon: "success" });
      return true;
    } catch (err) {
      wx.showToast({
        title: err instanceof Error ? err.message.slice(0, 18) : "保存失败",
        icon: "none",
      });
      wx.showModal({ title: "保存失败", content: "请检查网络和相册权限。若曾拒绝相册权限，可前往设置允许保存。", confirmText: "打开设置", success: ({ confirm }) => { if (confirm) wx.openSetting(); } });
      return false;
    } finally {
      wx.hideLoading();
      this.setData({ saving: false });
    }
  },

  async share() {
    if (!this.data.src) return;
    wx.showLoading({ title: "准备中", mask: true });
    try {
      const filePath = await download(this.data.src);
      if (wx.showShareImageMenu) {
        wx.showShareImageMenu({ path: filePath });
      } else {
        wx.previewImage({ urls: [filePath] });
      }
    } catch {
      wx.showToast({ title: "分享失败", icon: "none" });
    } finally {
      wx.hideLoading();
    }
  },

  async retouch() {
    if (!(await getApp().ensureSession())) return;
    getApp().globalData.pendingRefs = this.data.src ? [this.data.src] : [];
    wx.switchTab({ url: "/pages/studio/index" });
  },

  goStudio() { wx.switchTab({ url: "/pages/studio/index" }); },
});
