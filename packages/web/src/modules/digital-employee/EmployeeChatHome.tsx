import { useI18n } from "../../i18n/index.js";

const PROMPTS = [
  "今天有哪些客户必须跟？",
  "这类客户多吗，值得做个活动吗？",
  "帮我记一下刚才和客户聊的内容。",
];

/** The first screen of a new conversation. */
export function EmployeeChatHome({ name, onPrompt }: { name: string; onPrompt: (prompt: string) => void }) {
  const { t } = useI18n();
  return <section className="de-home de-employee-chat-home" aria-label={t("新对话")}>
    <h1>{t("{0}在这里", [name])}</h1>
    <p>{t("一句话交代就行，客户、跟进、客群和活动可以放在同一个对话里")}</p>
    <div className="de-quick-prompts">
      {PROMPTS.map((prompt) => <button key={prompt} type="button" onClick={() => onPrompt(t(prompt))}>
        {t(prompt)}<span aria-hidden>↗</span>
      </button>)}
    </div>
  </section>;
}
