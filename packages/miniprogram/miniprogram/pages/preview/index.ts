import { api, absoluteMedia } from "../../services/api";

function decode(value?: string): string {
  try { return value ? decodeURIComponent(value) : ""; } catch { return ""; }
}

function saveToAlbum(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({
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
    src: "",
    title: "",
    shareToken: "",
    shared: false,
    loading: false,
    sharing: false,
    error: "",
  },

  sharedToken: "",

  onLoad(query: { src?: string; title?: string; share?: string }) {
    wx.hideShareMenu({ menus: ["shareAppMessage", "shareTimeline"] });
    this.sharedToken = query.share || "";
    this.setData({
      src: query.share ? "" : decode(query.src),
      title: query.share ? "" : decode(query.title),
      shared: !!query.share,
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
    if (token) wx.showShareMenu({ menus: ["shareAppMessage"] });
    else wx.hideShareMenu({ menus: ["shareAppMessage", "shareTimeline"] });
  },

  async loadShared() {
    this.setShareToken("");
    this.setData({ loading: true, error: "", src: "" });
    try {
      const work = await api.sharedImage(this.sharedToken);
      this.setData({ src: absoluteMedia(work.url), title: work.title });
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
      this.setData({ title: share.title });
      this.setShareToken(share.token);
      wx.showToast({ title: "卡片已就绪，点击发送", icon: "none" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "分享准备失败", icon: "none" });
    } finally { this.setData({ sharing: false }); }
  },

  revokeShare() {
    if (!this.data.shareToken || this.data.shared || this.data.sharing) return;
    wx.showModal({
      title: "撤销作品分享", content: "撤销后，之前的卡片将无法打开作品。已保存的图片不会被收回。", confirmText: "撤销分享",
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
      title: this.data.title || "看看我做的图",
      imageUrl: this.data.src || undefined,
      path: `/pages/preview/index?share=${encodeURIComponent(this.data.shareToken)}`,
    };
  },

  preview() {
    if (!this.data.src) return;
    wx.previewImage({ urls: [this.data.src], current: this.data.src });
  },

  async save() {
    if (!this.data.src) return;
    wx.showLoading({ title: "保存中", mask: true });
    try {
      const filePath = await download(this.data.src);
      try {
        await saveToAlbum(filePath);
      } catch {
        await new Promise<void>((resolve, reject) => {
          wx.authorize({
            scope: "scope.writePhotosAlbum",
            success: () => resolve(),
            fail: () => reject(new Error("需要相册权限")),
          });
        });
        await saveToAlbum(filePath);
      }
      wx.showToast({ title: "已存进相册", icon: "success" });
    } catch (err) {
      wx.showToast({
        title: err instanceof Error ? err.message.slice(0, 18) : "保存失败",
        icon: "none",
      });
    } finally {
      wx.hideLoading();
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
