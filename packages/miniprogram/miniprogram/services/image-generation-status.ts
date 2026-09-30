const ROTATION_MS = 5000;
const STAGES = [
  { progress: 0, texts: ["正在构思画面", "正在整理创作灵感"] },
  { progress: 20, texts: ["正在勾勒构图", "正在安排画面层次"] },
  { progress: 50, texts: ["正在描绘画面", "正在丰富色彩与光影"] },
  { progress: 80, texts: ["正在润色图片", "正在调整光影氛围"] },
  { progress: 90, texts: ["正在优化图片细节", "正在优化整体风格", "正在打磨画面质感"] },
];

/** 本地等待提示，并非模型返回的真实工序；复用任务轮询，无额外定时器。 */
export function createImageGenerationStatus(): (progress: number, now?: number) => string {
  let currentStage = -1;
  let stageStartedAt = 0;
  return (progress, now = Date.now()) => {
    let stage = 0;
    for (let i = 1; i < STAGES.length; i++) {
      if (progress >= STAGES[i].progress) stage = i;
    }
    if (stage !== currentStage) {
      currentStage = stage;
      stageStartedAt = now;
    }
    const texts = STAGES[stage].texts;
    const index = Math.floor(Math.max(0, now - stageStartedAt) / ROTATION_MS) % texts.length;
    return texts[index];
  };
}
