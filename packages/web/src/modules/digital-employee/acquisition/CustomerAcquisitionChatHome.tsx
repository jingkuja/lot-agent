import { useI18n } from "../../../i18n/index.js";
interface CustomerAcquisitionChatHomeProps {
  onOpenWorkspace: () => void;
  onPrompt: (prompt: string) => void;
}

const PROMPTS = [
  "总结目前整体客户群最集中的三个需求，并说明数据局限。",
  "找出华东地区正在评估的潜客，先保存客群并确认排除项。",
  "结合产品资料判断这类客户更适合推广哪个产品，为什么。",
  "为下周活动建立一份营销简报，并生成一套朋友圈文案。",
];

export function CustomerAcquisitionChatHome({ onOpenWorkspace, onPrompt }: CustomerAcquisitionChatHomeProps) {
  const { t } = useI18n();
  return <section className="de-home de-acquisition-chat-home" aria-label={t("获客宝对话工作台")}>
    <header className="de-home-header">
      <div className="de-home-heading">
        <span className="de-home-mark" aria-hidden>✦</span>
        <div>
          <p className="de-home-eyebrow">{t("获客宝对话")}</p>
          <h1>{t("从客群洞察到营销内容")}</h1>
          <p>{t("当前对话只使用脱敏聚合群像、已确认产品资料和明确的公开受众，不处理单个客户跟进。")}</p>
        </div>
      </div>
      <button type="button" className="de-primary-button" onClick={onOpenWorkspace}>{t("打开获客宝工作台")}</button>
    </header>
    <div className="de-acquisition-chat-boundary">
      <div><span>{t("当前作用域")}</span><strong>{t("客群 / 公开受众")}</strong></div>
      <p>{t("可以查询群像、保存客群、创建活动和生成文案；付费海报与视频需先检查模型并由你确认后再生成。")}</p>
    </div>
    <div className="de-quick-prompts" aria-label={t("获客宝快捷指令")}>
      <span>{t("快捷开始")}</span>
      {PROMPTS.map((prompt) => <button key={prompt} type="button" onClick={() => onPrompt(t(prompt))}>
        {t(prompt)}<span aria-hidden>↗</span>
      </button>)}
    </div>
  </section>;
}
