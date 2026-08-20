interface CustomerAcquisitionChatHomeProps {
  onOpenWorkspace: () => void;
  onPrompt: (prompt: string) => void;
}

const PROMPTS = [
  "总结目前整体客户群最集中的三个需求，并说明数据局限。",
  "列出已经保存的客群，并比较各客群的规模、风险和常见异议。",
  "读取今天的获客推荐，解释为什么建议这些客群和产品组合。",
  "检查获客宝固定使用的图片和视频模型是否已经配置。",
];

export function CustomerAcquisitionChatHome({ onOpenWorkspace, onPrompt }: CustomerAcquisitionChatHomeProps) {
  return <section className="de-home de-acquisition-chat-home" aria-label="获客宝对话工作台">
    <header className="de-home-header">
      <div className="de-home-heading">
        <span className="de-home-mark" aria-hidden>✦</span>
        <div>
          <p className="de-home-eyebrow">获客宝对话</p>
          <h1>从客群洞察到营销内容</h1>
          <p>当前对话只使用脱敏聚合群像、已确认产品资料和明确的公开受众，不处理单个客户跟进。</p>
        </div>
      </div>
      <button type="button" className="de-primary-button" onClick={onOpenWorkspace}>打开获客宝工作台</button>
    </header>
    <div className="de-acquisition-chat-boundary">
      <div><span>当前作用域</span><strong>客群 / 公开受众</strong></div>
      <p>可以查询群像、解释推荐、检查资产和生成文案；海报与视频需进入工作台确认模型、受众和费用。</p>
    </div>
    <div className="de-quick-prompts" aria-label="获客宝快捷指令">
      <span>快捷开始</span>
      {PROMPTS.map((prompt) => <button key={prompt} type="button" onClick={() => onPrompt(prompt)}>
        {prompt}<span aria-hidden>↗</span>
      </button>)}
    </div>
  </section>;
}
