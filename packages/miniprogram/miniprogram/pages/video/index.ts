import { api } from "../../services/api";
import { VIDEO_MODELS, VIDEO_STEPS, createVideoDraft, submitVideo, recoverVideoTask, videoResult, type VideoDraft } from "../../services/video";
import { toastError } from "../../services/generate";

Page({
  data: {
    steps: VIDEO_STEPS, models: VIDEO_MODELS, step: 0, draft: createVideoDraft(),
    voices: ["自然旁白", "温柔女声", "沉稳男声", "活力讲述", "无配音"],
    music: ["无配乐", "轻快", "舒缓", "电影感", "动感"], ratios: ["9:16", "16:9", "1:1"], durations: [5, 10],
    busy: false, writing: false, pending: false, status: "", resultUrl: "", conversationId: "", taskId: "",
  },
  timer: null as ReturnType<typeof setTimeout> | null,
  storageKey: "", visible: false, checking: false,

  async onShow() {
    this.visible = true;
    if (!(await getApp().ensureSession()) || !this.visible) return;
    const key = `lot:video:${getApp().globalData.user?.id || "debug"}`;
    if (this.storageKey !== key) {
      this.storageKey = key;
      const saved = wx.getStorageSync(key) as Record<string, unknown> | undefined;
      this.setData({ step: 0, draft: createVideoDraft(), busy: false, writing: false, pending: false, status: "", resultUrl: "", conversationId: "", taskId: "" });
      if (saved && typeof saved === "object") {
        const draft = { ...createVideoDraft() };
        const stored = saved.draft as Partial<VideoDraft> | undefined;
        if (stored) for (const name of Object.keys(draft) as Array<keyof VideoDraft>) {
          if (typeof stored[name] === typeof draft[name]) (draft as Record<string, unknown>)[name] = stored[name];
        }
        if (!VIDEO_MODELS[draft.modelIndex]) draft.modelIndex = 0;
        if (!["9:16", "16:9", "1:1"].includes(draft.ratio)) draft.ratio = "9:16";
        if (![5, 10].includes(draft.durationSec)) draft.durationSec = 5;
        this.setData({ draft, step: Math.max(0, Math.min(6, Number(saved.step) || 0)),
          resultUrl: typeof saved.resultUrl === "string" ? saved.resultUrl : "",
          conversationId: typeof saved.conversationId === "string" ? saved.conversationId : "",
          taskId: typeof saved.taskId === "string" ? saved.taskId : "",
          pending: saved.pending === true });
      }
    }
    if (this.data.pending) void this.checkTask();
  },
  onHide() { this.visible = false; this.stopPolling(); this.persist(); },
  onUnload() { this.visible = false; this.stopPolling(); this.persist(); },
  persist() {
    if (!this.storageKey) return;
    const { draft, step, resultUrl, conversationId, taskId, pending } = this.data;
    wx.setStorageSync(this.storageKey, { draft, step, resultUrl, conversationId, taskId, pending });
  },
  stopPolling() { if (this.timer) clearTimeout(this.timer); this.timer = null; },
  field(e: { currentTarget: { dataset: { field: keyof VideoDraft } }; detail: { value: string } }) {
    if (this.data.busy || this.data.writing || this.data.pending) return;
    this.setData({ [`draft.${e.currentTarget.dataset.field}`]: e.detail.value }); this.persist();
  },
  choose(e: { currentTarget: { dataset: { field: keyof VideoDraft; value: string | number } } }) {
    if (this.data.busy || this.data.pending) return;
    const { field, value } = e.currentTarget.dataset;
    this.setData({ [`draft.${field}`]: field === "modelIndex" || field === "durationSec" ? Number(value) : value }); this.persist();
  },
  toggleSubtitles(e: { detail: { value: boolean } }) { this.setData({ "draft.subtitles": e.detail.value }); this.persist(); },
  goStep(e: { currentTarget: { dataset: { step: number } } }) { this.setData({ step: Number(e.currentTarget.dataset.step) }); this.persist(); },
  previous() { this.setData({ step: Math.max(0, this.data.step - 1) }); this.persist(); },
  next() {
    if (this.data.step === 0 && !this.data.draft.script.trim()) { wx.showToast({ title: "请先填写或生成文案", icon: "none" }); return; }
    this.setData({ step: Math.min(6, this.data.step + 1) }); this.persist();
  },
  async writeCopy() {
    if (this.data.writing || this.data.busy || this.data.pending) return;
    if (!this.data.draft.topic.trim()) { wx.showToast({ title: "先写下视频主题", icon: "none" }); return; }
    if (!(await getApp().ensureSession())) return;
    const owner = this.storageKey;
    this.setData({ writing: true });
    try {
      const copy = await api.videoCopy(this.data.draft.topic);
      if (owner !== this.storageKey) return;
      this.setData({ draft: { ...this.data.draft, ...copy } }); this.persist();
    } catch (error) { if (owner === this.storageKey) toastError(error); }
    finally { if (owner === this.storageKey) this.setData({ writing: false }); }
  },
  chooseImage(e: { currentTarget: { dataset: { field: "reference" | "cover" } } }) {
    if (this.data.busy || this.data.pending) return;
    const field = e.currentTarget.dataset.field;
    wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["album", "camera"], success: (res) => {
      this.setData({ [`draft.${field}`]: res.tempFiles[0].tempFilePath }); this.persist();
    } });
  },
  removeImage(e: { currentTarget: { dataset: { field: "reference" | "cover" } } }) {
    if (this.data.busy || this.data.pending) return;
    this.setData({ [`draft.${e.currentTarget.dataset.field}`]: "" }); this.persist();
  },
  async generate() {
    if (this.data.busy || this.data.pending || this.data.writing) return;
    if (!this.data.draft.script.trim()) { this.setData({ step: 0 }); wx.showToast({ title: "请先填写视频文案", icon: "none" }); return; }
    if (!(await getApp().ensureSession())) return;
    const owner = this.storageKey;
    this.setData({ busy: true, status: "正在提交视频", resultUrl: "", taskId: "", conversationId: "" });
    try {
      const result = await submitVideo(this.data.draft, (id) => {
        if (owner !== this.storageKey) return;
        this.setData({ conversationId: id, pending: true }); this.persist();
      });
      if (owner !== this.storageKey) return;
      this.setData({ ...result, pending: true, status: "视频正在生成，可离开页面稍后查看" }); this.persist();
      void this.checkTask();
    } catch (error) {
      if (owner !== this.storageKey) return;
      const status = (error as { status?: number }).status;
      if (status && status < 500 && status !== 408) this.setData({ pending: false, conversationId: "" });
      this.setData({ status: error instanceof Error ? error.message : "提交失败，请重试" }); this.persist();
    } finally { if (owner === this.storageKey) this.setData({ busy: false }); }
  },
  async checkTask() {
    if (!this.data.conversationId || this.checking) return;
    const owner = this.storageKey;
    const conversationId = this.data.conversationId;
    this.checking = true; this.stopPolling();
    try {
      if (!this.data.taskId) {
        const taskId = await recoverVideoTask(conversationId);
        if (owner !== this.storageKey || conversationId !== this.data.conversationId) return;
        if (!taskId) { this.setData({ status: "提交结果仍待确认，请稍后查询进度" }); return; }
        this.setData({ taskId }); this.persist();
      }
      const task = await api.getTask(this.data.taskId);
      if (owner !== this.storageKey || conversationId !== this.data.conversationId) return;
      const url = videoResult(task);
      if (url) { this.setData({ resultUrl: url, pending: false, step: 6, status: "视频已生成，请预览确认效果" }); }
      else if (["failed", "cancelled", "succeeded"].includes(task.status)) {
        this.setData({ pending: false, status: task.output?.downloadFailed ? "视频下载失败，请在网页版作品中重试下载" : "生成未完成，请检查积分或调整内容后重试" });
      } else { this.setData({ status: "视频正在生成，可离开页面稍后查看" }); }
      this.persist();
    } catch { if (owner === this.storageKey && conversationId === this.data.conversationId) this.setData({ status: "暂时无法查询，任务仍保留，请稍后重试" }); }
    finally {
      this.checking = false;
      if (this.data.pending && this.visible) this.timer = setTimeout(() => { void this.checkTask(); }, 5000);
    }
  },
  newDraft() {
    if (this.data.busy || this.data.writing) return;
    wx.showModal({ title: "开始新视频", content: this.data.pending
      ? "当前任务可能仍在后台运行。开始新视频不会取消它，完成后可在「作品 → 视频」查看。确定开始吗？"
      : "开始后会清空当前草稿，已生成的视频仍保留在「作品 → 视频」。", confirmText: "开始新作", success: ({ confirm }) => {
        if (!confirm) return;
        this.stopPolling();
        this.setData({ draft: createVideoDraft(), step: 0, pending: false, resultUrl: "", taskId: "", conversationId: "", status: "" });
        this.persist();
      } });
  },

  openResult() {
    if (!this.data.resultUrl) return;
    const title = [this.data.draft.publishTitle || this.data.draft.mainTitle, this.data.draft.tags].filter(Boolean).join(" ");
    wx.navigateTo({ url: `/pages/preview/index?type=video&src=${encodeURIComponent(this.data.resultUrl)}&title=${encodeURIComponent(title)}` });
  },
});
