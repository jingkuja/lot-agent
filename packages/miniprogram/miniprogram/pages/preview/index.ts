function saveToAlbum(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => resolve(),
      fail: (err) => reject(new Error(err.errMsg)),
    });
  });
}

Page({
  data: {
    src: "",
    title: "",
  },

  onLoad(query: { src?: string; title?: string }) {
    this.setData({
      src: query.src ? decodeURIComponent(query.src) : "",
      title: query.title ? decodeURIComponent(query.title) : "",
    });
  },

  preview() {
    if (!this.data.src) return;
    wx.previewImage({ urls: [this.data.src], current: this.data.src });
  },

  async save() {
    if (!this.data.src) return;
    wx.showLoading({ title: "保存中", mask: true });
    try {
      const filePath = await new Promise<string>((resolve, reject) => {
        wx.downloadFile({
          url: this.data.src,
          success: (res) =>
            res.statusCode === 200 ? resolve(res.tempFilePath) : reject(new Error("下载失败")),
          fail: (err) => reject(new Error(err.errMsg)),
        });
      });
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
    try {
      const filePath = await new Promise<string>((resolve, reject) => {
        wx.downloadFile({
          url: this.data.src,
          success: (res) =>
            res.statusCode === 200 ? resolve(res.tempFilePath) : reject(new Error("下载失败")),
          fail: (err) => reject(new Error(err.errMsg)),
        });
      });
      if (wx.showShareImageMenu) {
        wx.showShareImageMenu({ path: filePath });
      } else {
        wx.previewImage({ urls: [filePath] });
      }
    } catch {
      wx.showToast({ title: "分享失败", icon: "none" });
    }
  },

  retouch() {
    getApp().globalData.pendingRefs = this.data.src ? [this.data.src] : [];
    wx.switchTab({ url: "/pages/studio/index" });
  },
});
