interface OpportunityAdvisorChatHomeProps {
  onOpenWorkspace: () => void;
  onPrompt: (prompt: string) => void;
}

const PROMPTS = [
  "今天有哪些客户必须跟？说明是确定性提醒还是待判断商机。",
  "列出已经逾期但还没有结果的客户。",
  "查一下最近一直没有回复的客户，下一步该怎么跟。",
  "给当前这位客户生成一条不强推销的微信跟进。",
];

export function OpportunityAdvisorChatHome({ onOpenWorkspace, onPrompt }: OpportunityAdvisorChatHomeProps) {
  return (
    <section className="de-home de-acquisition-chat-home" aria-label="商机参谋对话工作台">
      <header className="de-home-header">
        <div className="de-home-heading">
          <span className="de-home-mark" aria-hidden>◇</span>
          <div>
            <p className="de-home-eyebrow">商机参谋对话</p>
            <h1>盯住每个客户，推动每次跟进</h1>
            <p>当前对话只处理单个客户：查询今日队列、解释原因、安排行动、生成个性化话术并回填结果。</p>
          </div>
        </div>
        <button type="button" className="de-primary-button" onClick={onOpenWorkspace}>打开商机参谋工作台</button>
      </header>
      <div className="de-acquisition-chat-boundary">
        <div><span>当前作用域</span><strong>单个客户 / 跟进行动</strong></div>
        <p>可以查询队列、创建或改期行动、生成微信/电话话术并记录结果；群发海报和视频请到获客宝。</p>
      </div>
      <div className="de-quick-prompts" aria-label="商机参谋快捷指令">
        <span>快捷开始</span>
        {PROMPTS.map((prompt) => (
          <button key={prompt} type="button" onClick={() => onPrompt(prompt)}>
            {prompt}<span aria-hidden>↗</span>
          </button>
        ))}
      </div>
    </section>
  );
}
