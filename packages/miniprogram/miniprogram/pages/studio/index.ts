import { IDEAS, QUALITIES, RATIOS } from "../../services/config";
import { runImageGeneration, toastError } from "../../services/generate";
import { clearStudioConversationId } from "../../services/session";
import { fillTemplate, POSTER_TEMPLATES } from "../../services/templates";

const ratioItems = RATIOS.map((item) => item.label);
const qualityItems = QUALITIES.map((item) => item.label);

Page({
  data: {
    prompt: "",
    size: RATIOS[0].size,
    ratioLabel: RATIOS[0].label,
    quality: "auto",
    qualityLabel: "自动",
    refs: [] as string[],
    resultUrl: "",
    busy: false,
    statusText: "",
    ideas: IDEAS,
    showIdeas: false,
    showMore: false,
  },

  onShow() {
    const app = getApp();
    if (app.globalData.pendingRefs?.length) {
      this.setData({ refs: app.globalData.pendingRefs.slice() });
      app.globalData.pendingRefs = [];
    }
    const job = app.globalData.posterJob;
    if (job) {
      app.globalData.posterJob = null;
      const tpl = POSTER_TEMPLATES.find((item) => item.id === job.id);
      if (tpl) {
        const ratio = RATIOS.find((item) => item.size === tpl.size);
        this.setData({
          prompt: fillTemplate(tpl.prompt, job.topic),
          size: tpl.size,
          ratioLabel: ratio?.label || tpl.ratio,
          resultUrl: "",
        });
      }
    }
  },

  onLoad(query: { prompt?: string; size?: string; topic?: string; template?: string }) {
    if (query.template) {
      const tpl = POSTER_TEMPLATES.find((item) => item.id === query.template);
      if (tpl) {
        const prompt = fillTemplate(tpl.prompt, query.topic || "");
        const ratio = RATIOS.find((item) => item.size === tpl.size);
        this.setData({
          prompt,
          size: tpl.size,
          ratioLabel: ratio?.label || tpl.ratio,
        });
      }
    } else if (query.prompt) {
      const ratio = RATIOS.find((item) => item.size === query.size);
      this.setData({
        prompt: decodeURIComponent(query.prompt),
        size: query.size || this.data.size,
        ratioLabel: ratio?.label || this.data.ratioLabel,
      });
    }
  },

  onPrompt(e: { detail: { value: string } }) {
    this.setData({ prompt: e.detail.value });
  },

  pickIdea(e: { currentTarget: { dataset: { text: string } } }) {
    this.setData({ prompt: e.currentTarget.dataset.text, showIdeas: false });
  },

  toggleIdeas() {
    this.setData({ showIdeas: !this.data.showIdeas, showMore: false });
  },

  closePopovers() {
    this.setData({ showIdeas: false, showMore: false });
  },

  toggleMore() {
    this.setData({ showMore: !this.data.showMore, showIdeas: false });
  },

  pickRatio() {
    wx.showActionSheet({
      itemList: [...ratioItems],
      success: (res) => {
        const item = RATIOS[res.tapIndex];
        if (item) this.setData({ size: item.size, ratioLabel: item.label });
      },
    });
  },

  pickQuality() {
    wx.showActionSheet({
      itemList: [...qualityItems],
      success: (res) => {
        const item = QUALITIES[res.tapIndex];
        if (item) this.setData({ quality: item.value, qualityLabel: item.label });
      },
    });
  },

  addRef() {
    wx.chooseMedia({
      count: Math.max(1, 5 - this.data.refs.length),
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (res) => {
        const extra = res.tempFiles.map((file) => file.tempFilePath);
        this.setData({ refs: this.data.refs.concat(extra).slice(0, 5) });
      },
    });
  },

  removeRef(e: { currentTarget: { dataset: { index: number } } }) {
    const refs = this.data.refs.slice();
    refs.splice(Number(e.currentTarget.dataset.index), 1);
    this.setData({ refs });
  },

  newSheet() {
    clearStudioConversationId();
    this.setData({ prompt: "", refs: [], resultUrl: "", statusText: "" });
  },

  async print() {
    if (this.data.busy) return;
    const prompt = this.data.prompt.trim();
    if (!prompt) {
      wx.showToast({ title: "先说说想要什么样的图", icon: "none" });
      return;
    }
    if (!(await getApp().ensureSession())) return;
    this.setData({ busy: true, statusText: "正在提交" });
    try {
      const result = await runImageGeneration({
        prompt,
        size: this.data.size,
        quality: this.data.quality,
        localRefs: this.data.refs,
        reuseStudioConversation: true,
        onStatus: (text, progress) => {
          const suffix = typeof progress === "number" && progress > 0 ? ` ${progress}%` : "";
          this.setData({ statusText: `${text}${suffix}` });
        },
      });
      this.setData({ resultUrl: result.imageUrl, statusText: "做好啦" });
    } catch (err) {
      toastError(err);
      this.setData({ statusText: err instanceof Error ? err.message : "失败了,请再试一次" });
    } finally {
      this.setData({ busy: false });
    }
  },

  save() {
    if (!this.data.resultUrl) return;
    wx.navigateTo({
      url: `/pages/preview/index?src=${encodeURIComponent(this.data.resultUrl)}`,
    });
  },
});
