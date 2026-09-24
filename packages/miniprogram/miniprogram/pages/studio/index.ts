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
    remoteUrl: "",
    busy: false,
    statusText: "",
    progress: 0,
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

  openPoster() { wx.navigateTo({ url: "/pages/poster/index" }); },

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
    this.setData({ prompt: "", refs: [], resultUrl: "", remoteUrl: "", statusText: "" });
  },

  async print() {
    if (this.data.busy) return;
    const prompt = this.data.prompt.trim();
    if (!prompt) {
      wx.showToast({ title: "先说说想要什么样的图", icon: "none" });
      return;
    }
    if (!(await getApp().ensureSession())) return;
    const app = getApp();
    this.setData({ busy: true, statusText: "正在提交", progress: 0 });
    try {
      const result = await runImageGeneration({
        prompt,
        size: this.data.size,
        quality: this.data.quality,
        localRefs: this.data.refs,
        onStatus: (text, progress) => {
          const pct = typeof progress === "number" && progress >= 0 ? Math.min(100, Math.round(progress)) : 0;
          this.setData({ statusText: text, progress: pct });
          // 同步到全局在途任务,让 gallery 页能看到
          if (app.globalData.activeImageJob) {
            app.globalData.activeImageJob.progress = pct;
            app.globalData.activeImageJob.statusText = text;
          }
        },
        onTask: (info) => {
          app.globalData.activeImageJob = {
            conversationId: info.conversationId,
            taskId: info.taskId,
            title: info.title || prompt.slice(0, 24) || "未命名",
            progress: 0,
            statusText: "AI 正在画,请稍等",
          };
        },
      });
      // 先把图片下载到本地再渲染 —— 16:9 等大图直接给 <image> 用远程 URL 偶尔会加载失败,
      // 本地临时路径稳定。失败时退回远程 URL。displayUrl 用于渲染,remoteUrl 用于预览/保存/分享。
      const remoteUrl = result.imageUrl;
      let displayUrl = remoteUrl;
      try {
        const local = await new Promise<string>((resolve, reject) => {
          wx.downloadFile({
            url: remoteUrl,
            success: (res) => (res.statusCode === 200 ? resolve(res.tempFilePath) : reject(new Error("download failed"))),
            fail: () => reject(new Error("download failed")),
          });
        });
        if (local) displayUrl = local;
      } catch {
        /* 退回远程 URL */
      }
      this.setData({ resultUrl: displayUrl, remoteUrl, statusText: "做好啦", progress: 100 });
      app.globalData.activeImageJob = null;
    } catch (err) {
      toastError(err);
      this.setData({ statusText: err instanceof Error ? err.message : "失败了,请再试一次" });
      app.globalData.activeImageJob = null;
    } finally {
      this.setData({ busy: false });
    }
  },

  save() {
    // 预览/保存走远程 URL,本地临时路径只在当前页有效,跨页传会失效
    const url = this.data.remoteUrl || this.data.resultUrl;
    if (!url) return;
    wx.navigateTo({
      url: `/pages/preview/index?src=${encodeURIComponent(url)}`,
    });
  },

  onImgLoad() {
    /* 图片加载成功,无需额外动作 */
  },

  onImgError() {
    // 远程 URL 偶发加载失败时,退回到一个明确的提示而不是空白
    this.setData({ statusText: "图片加载失败,请到「作品」里查看" });
  },
});
