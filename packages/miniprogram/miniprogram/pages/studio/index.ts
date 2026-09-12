import { IDEAS, QUALITIES, RATIOS } from "../../services/config";
import { runImageGeneration, toastError } from "../../services/generate";
import { api } from "../../services/api";
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
    modelId: "",
    modelLabel: "默认模型",
    models: [] as string[],
    refs: [] as string[],
    resultUrl: "",
    busy: false,
    statusText: "",
    ideas: IDEAS,
    showIdeas: false,
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
    void this.loadModels();
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

  async loadModels() {
    try {
      const catalog = await api.models();
      const ids = (catalog.image || []).map((m) => m.id);
      if (!ids.length) return;
      const current = ids.includes(this.data.modelId) ? this.data.modelId : ids[0];
      this.setData({ models: ids, modelId: current, modelLabel: current });
    } catch {
      // Keep the server default when the catalog is unavailable.
    }
  },

  onPrompt(e: { detail: { value: string } }) {
    this.setData({ prompt: e.detail.value });
  },

  pickIdea(e: { currentTarget: { dataset: { text: string } } }) {
    this.setData({ prompt: e.currentTarget.dataset.text, showIdeas: false });
  },

  toggleIdeas() {
    this.setData({ showIdeas: !this.data.showIdeas });
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

  pickModel() {
    if (!this.data.models.length) {
      wx.showToast({ title: "暂无可用模型", icon: "none" });
      return;
    }
    wx.showActionSheet({
      itemList: this.data.models.slice(0, 6),
      success: (res) => {
        const id = this.data.models[res.tapIndex];
        if (id) this.setData({ modelId: id, modelLabel: id });
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
      wx.showToast({ title: "先写一句要印的内容", icon: "none" });
      return;
    }
    if (!(await getApp().ensureSession())) return;
    this.setData({ busy: true, statusText: "正在发稿" });
    try {
      const result = await runImageGeneration({
        prompt,
        size: this.data.size,
        quality: this.data.quality,
        model: this.data.modelId || undefined,
        localRefs: this.data.refs,
        reuseStudioConversation: true,
        onStatus: (text, progress) => {
          const suffix = typeof progress === "number" && progress > 0 ? ` ${progress}%` : "";
          this.setData({ statusText: `${text}${suffix}` });
        },
      });
      this.setData({ resultUrl: result.imageUrl, statusText: "印好了" });
    } catch (err) {
      toastError(err);
      this.setData({ statusText: err instanceof Error ? err.message : "失败" });
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
