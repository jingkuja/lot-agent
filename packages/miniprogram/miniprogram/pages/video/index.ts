import { pageShare } from "../../lib/page-share.js";
import { api } from "../../services/api";
import {
  VIDEO_MODELS, VIDEO_STEPS, LAST_VIDEO_STEP, VIDEO_VOICES, VIDEO_MUSIC, VIDEO_RATIOS, VIDEO_DURATION_MIN, VIDEO_DURATION_MAX,
  VIDEO_SUBMIT_GRACE_MS, VIDEO_TASK_STALE_MS, createVideoDraft, restoreVideoDraft, submitVideo, findVideoGeneration,
  videoResult, videoSignature, videoErrorText, isDefinitiveVideoRejection, type VideoDraft,
} from "../../services/video";

const WAIT_TIPS = [
  "视频制作可能需要数分钟",
  "可以先忙别的，回来继续查看进度",
  "完成后可在「作品 → 视频」查看",
  "发布前，记得预览并检查成片效果",
];

const DOWNLOAD_FAILED_TEXT = "视频已生成，但下载失败。请在网页版作品中重试下载，无需再次付费生成。";
const POLL_INTERVAL_MS = 5000;
const PERSIST_DEBOUNCE_MS = 400;
const TIP_INTERVAL_MS = 4000;

/** Everything about the current attempt; reset together on account switch / new draft. */
function idleState() {
  return { step: 0, draft: createVideoDraft(), busy: false, writing: false, pending: false, checking: false, unchanged: false, stale: false, downloadFailed: false, submittedSignature: "", startedAt: 0, elapsed: "", status: "", copyError: "", resultUrl: "", conversationId: "", taskId: "", waitTip: WAIT_TIPS[0] };
}

Page({
  ...pageShare("美图海报 · AI 视频创作", "/pages/video/index"),
  data: {
    steps: VIDEO_STEPS, lastStep: LAST_VIDEO_STEP, models: VIDEO_MODELS,
    voices: VIDEO_VOICES, music: VIDEO_MUSIC, ratios: VIDEO_RATIOS, durationMin: VIDEO_DURATION_MIN, durationMax: VIDEO_DURATION_MAX,
    /** busy || writing || pending — kept as one flag so the template has a single source of truth. */
    locked: false,
    ...idleState(),
  },
  timer: null as ReturnType<typeof setTimeout> | null,
  persistTimer: null as ReturnType<typeof setTimeout> | null,
  tipTimer: null as ReturnType<typeof setInterval> | null,
  tipIndex: 0,
  storageKey: "", visible: false, unloaded: false,

  async onShow() {
    this.visible = true;
    if (!(await getApp().ensureSession()) || !this.visible) return;
    const key = `lot:video:${getApp().globalData.user?.id || "debug"}`;
    if (this.storageKey !== key) {
      this.storageKey = key;
      const saved = wx.getStorageSync(key) as Record<string, unknown> | undefined;
      this.update(idleState());
      if (saved && typeof saved === "object") {
        const draft = restoreVideoDraft(saved.draft);
        const downloadFailed = saved.downloadFailed === true;
        this.update({ draft, step: Math.max(0, Math.min(LAST_VIDEO_STEP, Number(saved.step) || 0)),
          resultUrl: typeof saved.resultUrl === "string" ? saved.resultUrl : "",
          conversationId: typeof saved.conversationId === "string" ? saved.conversationId : "",
          taskId: typeof saved.taskId === "string" ? saved.taskId : "",
          pending: saved.pending === true,
          submittedSignature: typeof saved.submittedSignature === "string" ? saved.submittedSignature : (saved.resultUrl || saved.pending ? videoSignature(draft) : ""),
          downloadFailed,
          status: downloadFailed ? DOWNLOAD_FAILED_TEXT : "",
          startedAt: typeof saved.startedAt === "number" ? saved.startedAt : 0 });
      }
    }
    this.refreshState();
    if (this.data.resultUrl || this.data.downloadFailed) this.setData({ step: LAST_VIDEO_STEP });
    if (this.data.pending) { this.update({ step: LAST_VIDEO_STEP }); this.startTipRotation(); void this.checkTask(); }
  },
  onHide() { this.visible = false; this.stopPolling(); this.stopTipRotation(); this.persist(); },
  onUnload() { this.unloaded = true; this.visible = false; this.stopPolling(); this.stopTipRotation(); this.persist(); },

  /** setData plus the derived `locked` flag. */
  update(patch: Record<string, unknown>) {
    this.setData(patch);
    // Every terminal path (including rejection and account reset) releases timers.
    if (!this.data.pending) { this.stopPolling(); this.stopTipRotation(); }
    const locked = !!(this.data.busy || this.data.writing || this.data.pending);
    if (locked !== this.data.locked) this.setData({ locked });
  },
  locked() { return !!(this.data.busy || this.data.writing || this.data.pending); },
  refreshState() {
    const { startedAt, pending } = this.data;
    const waitedMs = startedAt ? Date.now() - startedAt : 0;
    const minutes = Math.floor(waitedMs / 60000);
    this.setData({
      unchanged: !!(this.data.resultUrl || this.data.downloadFailed) && this.data.submittedSignature === videoSignature(this.data.draft),
      elapsed: pending && minutes > 0 ? `已等待 ${minutes} 分钟` : "",
      // A task older than the stale budget (or from a record with no start time) may be left to finish in the background.
      stale: pending && (!startedAt || waitedMs > VIDEO_TASK_STALE_MS),
    });
  },
  persist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.refreshState();
    if (!this.storageKey) return;
    const { draft, step, resultUrl, conversationId, taskId, pending, submittedSignature, downloadFailed, startedAt } = this.data;
    wx.setStorageSync(this.storageKey, { draft, step, resultUrl, conversationId, taskId, pending, submittedSignature, downloadFailed, startedAt });
  },
  /** Typing fires per keystroke; storage writes are synchronous, so coalesce them. */
  persistSoon() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persist(); }, PERSIST_DEBOUNCE_MS);
  },
  stopPolling() { if (this.timer) clearTimeout(this.timer); this.timer = null; },
  startTipRotation() {
    this.stopTipRotation();
    if (!this.visible || this.unloaded || !this.data.pending) return;
    this.tipIndex = 0;
    this.setData({ waitTip: WAIT_TIPS[0] });
    this.tipTimer = setInterval(() => {
      this.tipIndex = (this.tipIndex + 1) % WAIT_TIPS.length;
      this.setData({ waitTip: WAIT_TIPS[this.tipIndex] });
    }, TIP_INTERVAL_MS);
  },
  stopTipRotation() { if (this.tipTimer) { clearInterval(this.tipTimer); this.tipTimer = null; } },
  field(e: { currentTarget: { dataset: { field: keyof VideoDraft } }; detail: { value: string } }) {
    if (this.locked()) return;
    this.setData({ [`draft.${e.currentTarget.dataset.field}`]: e.detail.value }); this.persistSoon();
  },
  choose(e: { currentTarget: { dataset: { field: keyof VideoDraft; value: string | number } } }) {
    if (this.locked()) return;
    const { field, value } = e.currentTarget.dataset;
    this.setData({ [`draft.${field}`]: field === "modelIndex" || field === "durationSec" ? Number(value) : value }); this.persist();
  },
  changeDuration(e: { detail: { value: number } }) {
    if (this.locked()) return;
    const value = e.detail.value;
    if (!Number.isInteger(value) || value < VIDEO_DURATION_MIN || value > VIDEO_DURATION_MAX) return;
    this.setData({ "draft.durationSec": value });
    this.persistSoon();
  },
  toggleSubtitles(e: { detail: { value: boolean } }) { if (this.locked()) return; this.setData({ "draft.subtitles": e.detail.value }); this.persist(); },
  goStep(e: { currentTarget: { dataset: { step: number } } }) {
    if (this.locked() || this.data.resultUrl || this.data.downloadFailed) return;
    const step = Number(e.currentTarget.dataset.step);
    if (step > 0 && !this.data.draft.script.trim()) { wx.showToast({ title: "请先填写或生成文案", icon: "none" }); return; }
    this.setData({ step: Math.max(0, Math.min(LAST_VIDEO_STEP, step)) }); this.persist();
  },
  previous() {
    if (this.locked() || (this.data.step === LAST_VIDEO_STEP && (this.data.resultUrl || this.data.downloadFailed))) return;
    this.setData({ step: Math.max(0, this.data.step - 1) }); this.persist();
  },
  next() {
    if (this.locked()) return;
    if (this.data.step === 0 && !this.data.draft.script.trim()) { wx.showToast({ title: "请先填写或生成文案", icon: "none" }); return; }
    this.setData({ step: Math.min(LAST_VIDEO_STEP, this.data.step + 1) }); this.persist();
  },
  async writeCopy() {
    if (this.locked()) return;
    if (!this.data.draft.topic.trim()) { wx.showToast({ title: "先写下视频主题", icon: "none" }); return; }
    const owner = this.storageKey;
    this.update({ writing: true, copyError: "" });
    try {
      if (!(await getApp().ensureSession()) || owner !== this.storageKey) return;
      const copy = await api.videoCopy(this.data.draft.topic);
      if (this.unloaded || owner !== this.storageKey) return;
      this.setData({ draft: { ...this.data.draft, ...copy } }); this.persist();
    } catch (error) {
      if (!this.unloaded && owner === this.storageKey) this.setData({ copyError: videoErrorText(error, "文案生成失败，请稍后重试，也可直接填写文案") });
    } finally { if (!this.unloaded && owner === this.storageKey) this.update({ writing: false }); }
  },
  chooseImage(e: { currentTarget: { dataset: { field: "reference" | "cover" } } }) {
    if (this.locked()) return;
    const field = e.currentTarget.dataset.field;
    const owner = this.storageKey;
    wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["album", "camera"], success: (res) => {
      if (this.unloaded || this.locked() || owner !== this.storageKey) return;
      this.setData({ [`draft.${field}`]: res.tempFiles[0].tempFilePath }); this.persist();
    } });
  },
  removeImage(e: { currentTarget: { dataset: { field: "reference" | "cover" } } }) {
    if (this.locked()) return;
    this.setData({ [`draft.${e.currentTarget.dataset.field}`]: "" }); this.persist();
  },
  async generate() {
    if (this.locked()) return;
    if (!this.data.draft.script.trim()) { this.setData({ step: 0 }); wx.showToast({ title: "请先填写视频文案", icon: "none" }); return; }
    this.refreshState();
    if (this.data.unchanged) { wx.showToast({ title: "相同设置已生成，请先查看成片", icon: "none" }); return; }
    const owner = this.storageKey;
    const draft = { ...this.data.draft };
    // Lock synchronously, before login or confirmation can yield to a second tap.
    this.update({ busy: true });
    try {
      if (!(await getApp().ensureSession()) || owner !== this.storageKey) return;
      const model = VIDEO_MODELS[draft.modelIndex];
      const repeat = !!(this.data.resultUrl || this.data.downloadFailed);
      const confirmed = await new Promise<boolean>((resolve) => wx.showModal({
        title: repeat ? "确认再次生成" : "确认生成视频",
        content: `${model.label} · ${model.resolution} · ${draft.ratio} · ${draft.durationSec} 秒\n${repeat ? "这是一次新的付费生成。" : "生成将消耗账户积分。"}视频制作可能需要数分钟，提交后请等待完成；离开页面不会取消任务。`,
        confirmText: "确认生成", cancelText: "再检查下",
        success: ({ confirm }) => resolve(confirm), fail: () => resolve(false),
      }));
      if (!confirmed || this.unloaded || owner !== this.storageKey || this.data.pending) return;
      this.update({ step: LAST_VIDEO_STEP, status: "正在提交，请勿重复操作" });
      const result = await submitVideo(draft, (id) => {
        if (this.unloaded || owner !== this.storageKey) throw new Error("页面或登录账户已切换，请重新操作");
        this.update({ conversationId: id, taskId: "", pending: true, resultUrl: "", downloadFailed: false,
          submittedSignature: videoSignature(draft), startedAt: Date.now() });
        this.startTipRotation();
        // This must be durable before the paid request is sent.
        this.persist();
      });
      if (this.unloaded || owner !== this.storageKey) return;
      this.update({ ...result, pending: true, status: "任务已提交，正在等待生成" }); this.persist();
    } catch (error) {
      if (this.unloaded || owner !== this.storageKey) return;
      if (isDefinitiveVideoRejection(error)) this.update({ pending: false, conversationId: "", taskId: "" });
      this.update({ status: videoErrorText(error, "提交失败，请检查网络或账户积分") }); this.persist();
      if ((error as { code?: string } | null)?.code === "INSUFFICIENT_BALANCE") {
        wx.showModal({ title: "积分不足", content: "当前积分不足以生成这条视频，充值后可继续。", confirmText: "去充值", cancelText: "稍后再说",
          success: ({ confirm }) => { if (confirm && !this.unloaded && owner === this.storageKey) wx.navigateTo({ url: "/pages/recharge/index" }); } });
      }
    } finally {
      if (!this.unloaded && owner === this.storageKey) {
        this.update({ busy: false });
        if (this.data.pending) void this.checkTask();
      }
    }
  },
  async checkTask() {
    if (!this.data.pending || !this.data.conversationId || this.data.checking || this.data.busy) return;
    const owner = this.storageKey;
    const conversationId = this.data.conversationId;
    const current = () => !this.unloaded && owner === this.storageKey && conversationId === this.data.conversationId;
    this.setData({ checking: true }); this.refreshState(); this.stopPolling();
    try {
      let taskId = this.data.taskId;
      if (!taskId) {
        // The submit response was lost: the conversation's generation message is the durable
        // record of whether (and how) the paid attempt happened.
        const generation = await findVideoGeneration(conversationId);
        if (!current()) return;
        if (!generation) {
          if (this.data.startedAt && Date.now() - this.data.startedAt > VIDEO_SUBMIT_GRACE_MS) {
            // Absence of a message is not proof that a delayed request cannot still enqueue.
            this.setData({ status: "暂时无法确认提交结果，请继续查询；原提交仍可能执行并消耗积分" });
          } else this.setData({ status: "提交结果仍待确认，请稍后查询进度" });
          return;
        }
        if (generation.url) { this.finishTask(generation.url); return; }
        if (generation.downloadFailed) { this.update({ pending: false, downloadFailed: true, status: DOWNLOAD_FAILED_TEXT }); return; }
        if (generation.status === "failed" || generation.status === "cancelled") { this.update({ pending: false, status: "生成未完成，请检查积分或调整内容后重试" }); return; }
        if (!generation.taskId) { this.setData({ status: "提交结果仍待确认，请稍后查询进度" }); return; }
        taskId = generation.taskId;
        this.setData({ taskId }); this.persist();
      }
      const task = await api.getTask(taskId);
      if (!current()) return;
      const url = videoResult(task);
      if (url) this.finishTask(url);
      else if (["failed", "cancelled", "succeeded"].includes(task.status)) {
        const downloadFailed = !!task.output?.downloadFailed;
        this.update({ pending: false, downloadFailed, status: downloadFailed ? DOWNLOAD_FAILED_TEXT : "生成未完成，请检查积分或调整内容后重试" });
      } else this.setData({ status: task.status === "pending" ? "任务排队中，请耐心等待" : "视频制作中，请耐心等待" });
    } catch { if (current()) this.setData({ status: "暂时无法查询，任务仍保留，请稍后重试" }); }
    finally {
      if (!this.unloaded && owner === this.storageKey) { this.setData({ checking: false }); this.persist(); }
      if (current() && this.data.pending && this.visible) this.timer = setTimeout(() => { void this.checkTask(); }, POLL_INTERVAL_MS);
    }
  },
  finishTask(resultUrl: string) {
    this.update({ resultUrl, pending: false, downloadFailed: false, step: LAST_VIDEO_STEP, status: "视频已生成，请预览确认效果" });
  },
  /** Release the page from a long-running task without cancelling it; the result still lands in 作品. */
  stopWaiting() {
    this.refreshState();
    if (!this.data.pending || !this.data.stale || this.data.busy) return;
    const owner = this.storageKey;
    this.update({ busy: true });
    const resume = () => {
      if (this.unloaded || owner !== this.storageKey) return;
      this.update({ busy: false });
      if (this.data.pending && this.visible) void this.checkTask();
    };
    wx.showModal({ title: "不再等待这条视频", content: "停止等待不会取消原提交，原提交仍可能执行并消耗积分，完成后可在「作品 → 视频」查看。之后再点生成会是一次新的付费生成。", confirmText: "不再等待", cancelText: "继续等待", success: ({ confirm }) => {
      if (this.unloaded || owner !== this.storageKey) return;
      if (confirm) {
        this.stopPolling();
        this.update({ pending: false, conversationId: "", taskId: "", startedAt: 0, status: "已停止等待，原提交仍可能执行并消耗积分，完成后见「作品」" });
        this.persist();
      }
      resume();
    }, fail: resume });
  },
  newDraft() {
    if (this.locked()) return;
    const owner = this.storageKey;
    this.update({ busy: true });
    wx.showModal({ title: "开始新视频", content: "开始后会清空当前草稿，已生成的视频仍保留在「作品 → 视频」。", confirmText: "开始新作", success: ({ confirm }) => {
      if (this.unloaded || owner !== this.storageKey) return;
      if (confirm && !this.data.pending) {
        this.stopPolling();
        this.update({ ...idleState(), busy: true });
        this.persist();
      }
      this.update({ busy: false });
    }, fail: () => { if (!this.unloaded && owner === this.storageKey) this.update({ busy: false }); } });
  },

  async openResult() {
    if (!this.data.resultUrl) return;
    const copy = this.data.draft.publishTitle || this.data.draft.mainTitle;
    const tags = this.data.draft.tags;
    const title = [copy, tags].filter(Boolean).join(" ");
    const owner = this.storageKey;
    const resultUrl = this.data.resultUrl;
    if (this.data.conversationId) {
      // Preview already receives these fields; syncing must not delay navigation.
      void api.saveVideoPublication(this.data.conversationId, { copy, tags }).catch(() => {
        if (!this.unloaded && owner === this.storageKey) wx.showToast({ title: "发布信息同步失败，本机草稿已保留", icon: "none" });
      });
    }
    if (this.unloaded || owner !== this.storageKey || resultUrl !== this.data.resultUrl) return;
    wx.navigateTo({ url: `/pages/preview/index?type=video&src=${encodeURIComponent(this.data.resultUrl)}&title=${encodeURIComponent(title)}&copy=${encodeURIComponent(copy)}&tags=${encodeURIComponent(tags)}` });
  },
});
