import { RATIOS } from "../../services/config";
import { runImageGeneration, toastError } from "../../services/generate";

Page({
  data: {
    refs: [] as string[],
    prompt: "",
    resultUrl: "",
    busy: false,
    statusText: "",
  },

  addRef() {
    wx.chooseMedia({
      count: Math.max(1, 5 - this.data.refs.length),
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (res) => {
        this.setData({
          refs: this.data.refs.concat(res.tempFiles.map((file) => file.tempFilePath)).slice(0, 5),
        });
      },
    });
  },

  removeRef(e: { currentTarget: { dataset: { index: number } } }) {
    const refs = this.data.refs.slice();
    refs.splice(Number(e.currentTarget.dataset.index), 1);
    this.setData({ refs });
  },

  onPrompt(e: { detail: { value: string } }) {
    this.setData({ prompt: e.detail.value });
  },

  sendToStudio() {
    getApp().globalData.pendingRefs = this.data.refs.slice();
    wx.switchTab({ url: "/pages/studio/index" });
  },

  async print() {
    if (!this.data.refs.length) {
      wx.showToast({ title: "先选一张要改的图", icon: "none" });
      return;
    }
    const prompt = this.data.prompt.trim() || "保持人物身份，提升画质与光线，做成可发布的照片";
    if (!(await getApp().ensureSession())) return;
    this.setData({ busy: true, statusText: "正在修版" });
    try {
      const result = await runImageGeneration({
        prompt,
        size: RATIOS[0].size,
        quality: "high",
        localRefs: this.data.refs,
        title: "修图",
        onStatus: (text) => this.setData({ statusText: text }),
      });
      this.setData({ resultUrl: result.imageUrl, statusText: "修好了" });
    } catch (err) {
      toastError(err);
    } finally {
      this.setData({ busy: false });
    }
  },

  preview() {
    if (!this.data.resultUrl) return;
    wx.navigateTo({
      url: `/pages/preview/index?src=${encodeURIComponent(this.data.resultUrl)}`,
    });
  },
});
