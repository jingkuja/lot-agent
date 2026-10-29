import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { fitMarketingNarration, marketingKeyArtIssue, marketingReferenceError, marketingRenderKey, marketingReviewText, marketingVoiceover,
  resolveMarketingSegments, type MarketingKeyArt, type MarketingNarrationClip, type MarketingTaskState, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import { request } from "../../api/client.js";
import { errorMessage, json, normalizeProject, requestProject, type Project } from "./api.js";
import type { ConfirmChoice, ConfirmRequest } from "./ConfirmDialog.js";
import { CONFIRM_STEP, generationChecks, generationConfirmation, reviewQuestion } from "./production-checks.js";
import { POLL_MAX_MS, POLL_MIN_MS, usePolling, useTaskPolling, type DraftSession } from "./session.js";
import type { DraftEditor } from "./useDraftEditor.js";
import type { TextRequests } from "./useTextRequests.js";

/** Twin narration takes of one saved version of a draft. */
type Narration = { projectId: string; version: number; clips: MarketingNarrationClip[] };
/** The key-art still of one saved version of a draft. */
type KeyArt = { projectId: string; version: number; keyArt: MarketingKeyArt };
type Translate = (source: string, values?: readonly unknown[]) => string;
export const POLL_ERROR = "暂时无法查询进度，正在自动重试；无需重复生成。";

/** Everything between a confirmed board and a made video: the twin narration takes and key-art
 * still the clips need, submitting the video or single shots again, and following its progress. */
export function useProduction({ editor, text, session, profile, ready, step, setStep, t, confirm, choose, wait, setError, setNotice }: {
  editor: DraftEditor; text: TextRequests; session: DraftSession; profile: MarketingVideoProfile;
  ready: boolean; step: number; setStep(step: number): void; t: Translate;
  confirm(request: ConfirmRequest): Promise<boolean>; choose(request: ConfirmRequest): Promise<ConfirmChoice>;
  wait(label: string, textRequest?: boolean): void;
  setError: Dispatch<SetStateAction<string>>; setNotice(message: string): void;
}) {
  const [narration, setNarration] = useState<Narration | null>(null);
  const [keyArt, setKeyArt] = useState<KeyArt | null>(null);
  const { draft, project, dirty, draftRef, projectRef, save, setCurrent } = editor;
  const frozen = !!project?.taskId;
  const active = project?.status === "pending" || project?.status === "running";

  useTaskPolling(project?.id, active, (state: MarketingTaskState) => {
    const p = projectRef.current;
    if (!p || p.id !== state.id) return;
    setCurrent({ ...p, taskId: state.taskId, status: state.status, progress: state.progress, stage: state.stage, error: state.error,
      errorCode: state.errorCode, output: state.output, unknownSegments: state.unknownSegments });
    // Whether single shots can be redone is known once the job stops; it comes with the full project.
    if (state.status !== "pending" && state.status !== "running") {
      const token = session.token();
      void requestProject(`/marketing-videos/${p.id}`).then(fresh => { if (session.current(token)) setCurrent(fresh); }).catch(() => {});
    }
  }, failed => setError(old => failed ? POLL_ERROR : old === POLL_ERROR ? "" : old));

  // Takes belong to the saved text and voice settings; reload them for each saved version. A made
  // twin-narrated video shows them too, so a take that failed while redoing shots can be made again.
  const voiceover = marketingVoiceover(draft);
  const hasBoard = !!draft.storyboard.length;
  const showsTakes = frozen ? !!project?.revision?.composition.narration : step === CONFIRM_STEP;
  useEffect(() => {
    if (!ready || !showsTakes || !voiceover || !hasBoard || !draft.narration?.twinItemId || !project || dirty) return;
    if (narration?.projectId === project.id && narration.version === project.version) return;
    const token = session.token();
    void request<{ version: number; clips: MarketingNarrationClip[] }>(`/marketing-videos/${project.id}/narration`).then(result => {
      if (session.current(token)) setNarration({ projectId: project.id, version: result.version, clips: result.clips });
    }).catch(e => { if (session.current(token)) setError(errorMessage(e)); });
  }, [ready, showsTakes, voiceover, hasBoard, draft.narration?.twinItemId, project?.id, project?.version, dirty]);
  const current = <T extends { projectId: string; version: number }>(value: T | null) =>
    value && project && value.projectId === project.id && value.version === project.version && !dirty ? value : null;
  const currentNarration = current(narration)?.clips ?? null;
  // Takes are made in the background; follow them until none runs, also after reopening the draft.
  const narrationRunning = !!currentNarration?.some(clip => clip.status === "running");
  usePolling<{ version: number; clips: MarketingNarrationClip[] }>(narrationRunning ? `/marketing-videos/${project?.id}/narration` : undefined,
    narrationRunning, result => {
      const p = projectRef.current;
      if (p && narration && p.id === narration.projectId) setNarration({ projectId: p.id, version: result.version, clips: result.clips });
    }, failed => setError(old => failed ? POLL_ERROR : old === POLL_ERROR ? "" : old));
  // The still belongs to the saved look; reload it for each saved version.
  const keyArtIssue = marketingKeyArtIssue(draft, profile);
  useEffect(() => {
    if (!ready || frozen || step !== CONFIRM_STEP || keyArtIssue || !hasBoard || !project || dirty) return;
    if (keyArt?.projectId === project.id && keyArt.version === project.version) return;
    const token = session.token();
    void request<{ version: number; keyArt: MarketingKeyArt }>(`/marketing-videos/${project.id}/key-art`).then(result => {
      if (session.current(token)) setKeyArt({ projectId: project.id, version: result.version, keyArt: result.keyArt });
    }).catch(e => { if (session.current(token)) setError(errorMessage(e)); });
  }, [ready, frozen, step, keyArtIssue, hasBoard, project?.id, project?.version, dirty]);
  const currentKeyArt = current(keyArt)?.keyArt ?? null;
  // The still is made in the background; follow it until it stops, also after reopening the draft.
  const keyArtRunning = currentKeyArt?.status === "running";
  usePolling<{ version: number; keyArt: MarketingKeyArt }>(keyArtRunning ? `/marketing-videos/${project?.id}/key-art` : undefined, keyArtRunning, result => {
    const p = projectRef.current;
    if (p && keyArt && p.id === keyArt.projectId) setKeyArt({ projectId: p.id, version: result.version, keyArt: result.keyArt });
  }, failed => setError(old => failed ? POLL_ERROR : old === POLL_ERROR ? "" : old));

  /** Submit the draft as a video, or continue its stopped job (`retry`) with the frozen input. */
  async function generate(retry = false) {
    // Retries resume a frozen job whose recorded model rules the server checks.
    const referenceError = retry ? "" : marketingReferenceError(draftRef.current, profile);
    if (referenceError) { setStep(1); throw new Error(referenceError); }
    if (!retry) resolveMarketingSegments(draftRef.current, profile);
    let p = await save();
    if (!retry) {
      let keyArtMade: boolean | undefined;
      let keyArtRunning = false;
      if (!marketingKeyArtIssue(p.draft, profile)) {
        const { keyArt: still } = await request<{ keyArt: MarketingKeyArt }>(`/marketing-videos/${p.id}/key-art`);
        // A still being made is not waited for: the video takes an earlier still of this look, or none.
        keyArtRunning = still.status === "running";
        keyArtMade = !!still.url;
        // The still is one more reference image, with the same quality limit.
        const keyArtError = keyArtMade ? marketingReferenceError(p.draft, profile, true) : "";
        if (keyArtError) throw new Error(keyArtError);
      }
      // Everything the checklist warns about is accepted in one confirmation.
      const confirmation = generationConfirmation(generationChecks(p.draft, { keyArt: keyArtMade, keyArtRunning }), t);
      if (confirmation && !await confirm(confirmation)) return;
      // Checking the copy is offered, not required: unchecked or rejected copy may be generated directly.
      const verdict = p.review && p.reviewedScript === marketingReviewText(p.draft) ? p.review.verdict : undefined;
      const question = reviewQuestion(verdict);
      const choice = question ? await choose(question) : "alternative";
      if (!choice) return;
      if (choice === "confirm") {
        if (verdict === "reject") { setNotice("请按「文案与分镜检查」中的提示修改文案，或再次生成视频时选择「直接生成」。"); return; }
        await text.review();
        p = projectRef.current!;
        if (p.review?.verdict === "reject") throw new Error("文案检查发现需要修改的内容，请按「文案与分镜检查」中的提示修改后再生成。");
      }
    }
    wait("正在提交生成任务", false);
    const result = await requestProject(`/marketing-videos/${p.id}/generate`, json("POST", { version: p.version, retry }));
    if (!session.alive) return;
    setCurrent(result);
    // Titles and tags are publishing metadata, not part of the video: fill missing ones while
    // it is being made instead of before submitting it, then check just them before they are
    // published. A failure leaves them to the user.
    if (!retry && (!result.draft.publishTitle.trim() || !result.draft.tags.trim())) {
      try { await text.publication(true); await text.review(); }
      catch (e) {
        if (session.alive) setNotice(t("标题和标签补全失败：{0}。视频生成不受影响，可稍后点击「重新生成标题和标签」或手动填写。", [t(errorMessage(e))]));
      }
    }
  }
  /** Redo chosen shots of the current video; the server keeps every other clip unpaid. Changed shots of a
   * twin-narrated video first get their new takes in the background; once none is being made, the same redo
   * is sent again and reuses them, so leaving the page never pays for a take twice. A failed take is made
   * again only for the shots in `narrationRedo`, which the user confirmed, and only with the first request. */
  async function revise(shots: number[], narrationRedo: number[] = []) {
    let p = await save();
    // Composing the made draft again unchanged calls no model, so its text is not checked again.
    const unchanged = !shots.length && !!p.revision && marketingRenderKey(p.draft) === marketingRenderKey(p.revision.draft);
    if (!unchanged && (!p.review || p.reviewedScript !== marketingReviewText(p.draft))) { await text.review(); p = projectRef.current!; }
    if (!unchanged && p.review?.verdict === "reject") throw new Error("文案检查发现需要修改的内容，请按「文案与分镜检查」中的提示修改后再重新生成。");
    for (let redo = narrationRedo; ; redo = []) {
      wait("正在提交生成任务", false);
      const body = { version: p.version, shots, ...(redo.length ? { narrationRedo: redo } : {}) };
      type Pending = { narrationPending: true; clips: MarketingNarrationClip[] };
      const result = await request<Project | Pending>(`/marketing-videos/${p.id}/revise`, json("POST", body));
      if (!session.alive) return;
      if (!("narrationPending" in result)) { setCurrent(normalizeProject(result)); return; }
      setNarration({ projectId: p.id, version: p.version, clips: result.clips });
      wait("正在合成改动镜头的配音", false);
      if (!await narrationSettled(p.id, p.version)) return;
    }
  }
  /** Reads the takes, with the task polling backoff, until none is being made; false once the user left the draft. */
  async function narrationSettled(projectId: string, version: number) {
    const token = session.token();
    for (let delay = POLL_MIN_MS; ; delay = Math.min(Math.round(delay * 1.5), POLL_MAX_MS)) {
      await new Promise(done => setTimeout(done, delay));
      if (!session.current(token)) return false;
      const { clips } = await request<{ clips: MarketingNarrationClip[] }>(`/marketing-videos/${projectId}/narration`);
      if (!session.current(token)) return false;
      // Failed takes stay visible with their reasons and a button to make them again.
      setNarration({ projectId, version, clips });
      if (!clips.some(clip => clip.status === "running")) return true;
    }
  }
  // Back to what the video was made from; publishing fields are not part of it.
  const revertShots = () => {
    const base = projectRef.current?.revision?.draft;
    if (base) editor.update({ ...base, publishTitle: draftRef.current.publishTitle, tags: draftRef.current.tags });
  };
  /** Paid speech requests, one per shot without a take, or the chosen shots again. */
  async function synthesizeNarration(slots?: number[]) {
    const again = slots?.some(slot => currentNarration?.[slot]?.status === "succeeded");
    if (again && !await confirm({ title: "重新生成配音", message: "将重新合成第 {0} 镜配音，会再次产生费用。是否继续？",
      values: [slots!.map(slot => slot + 1).join("、")], confirm: "重新生成" })) return;
    const p = await save();
    wait("正在生成数字分身配音", false);
    const result = await request<{ version: number; clips: MarketingNarrationClip[]; error: string }>(`/marketing-videos/${p.id}/narration`, json("POST", { version: p.version, slots }));
    if (!session.alive) return;
    setNarration({ projectId: p.id, version: result.version, clips: result.clips });
    if (result.error) setError(result.error);
  }
  /** One paid image request: a still for the current look, or another one on `redo`. The server starts it
   * and answers at once; the panel follows it by polling. A still that was paid for and cut short is
   * fetched again for free instead, so it asks for no confirmation. */
  async function makeKeyArt(redo: boolean) {
    const free = currentKeyArt?.resumable === true;
    const message = currentKeyArt?.status === "running" ? "将放弃正在生成的定妆图并重新生成一张，会再次产生费用。是否继续？"
      : "将重新生成一张定妆图，会再次产生费用。是否继续？";
    if (redo && !free && !await confirm({ title: "重新生成定妆图", message, confirm: "重新生成" })) return;
    const p = await save();
    wait(free ? "正在获取定妆图" : "正在提交定妆图生成", false);
    const result = await request<{ version: number; keyArt: MarketingKeyArt }>(`/marketing-videos/${p.id}/key-art`, json("POST", { version: p.version, redo: redo && !free }));
    if (session.alive) setKeyArt({ projectId: p.id, version: result.version, keyArt: result.keyArt });
  }
  /** Lengthen shots whose take does not fit; the takes stay valid since shot time is not part of them. */
  function fitNarration() {
    const clips = currentNarration;
    if (!clips) return;
    try { editor.setShots(fitMarketingNarration(draftRef.current.storyboard, draftRef.current, profile, clips.map(clip => clip.durationMs))); }
    catch (e) { setError(errorMessage(e)); }
  }
  /** The user accepts a possible duplicate charge: resubmit only the clips whose outcome is unknown. */
  async function releaseUnknown(id: string) {
    const released = await request<{ project: Project }>(`/marketing-videos/${id}/unknown-segments/release`, json("POST", {}));
    if (session.alive) setCurrent(normalizeProject(released.project));
    await generate(true);
  }
  /** Save the made video and its publishing copy to the knowledge base. */
  async function archive() {
    const p = await save();
    const result = await request<{ itemId: string; version: number }>(`/marketing-videos/${p.id}/archive`, json("POST", {}));
    setCurrent({ ...p, knowledgeItemId: result.itemId, knowledgeVersion: result.version });
    setNotice("视频和发布文案已保存到知识库。");
  }

  return { frozen, currentNarration, currentKeyArt, keyArtIssue, voiceover,
    generate, revise, revertShots, synthesizeNarration, makeKeyArt, fitNarration, releaseUnknown, archive };
}
