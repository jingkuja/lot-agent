import { useState } from "react";

export interface AskUserInput {
  question?: string;
  options?: string[];
  allowFreeText?: boolean;
}

interface AskUserCardProps {
  input: unknown;
  /** 是否还在等待回答（是最后一次提问且未流式中）。 */
  interactive: boolean;
  /** 用户已给出的回答（其后第一条 user 消息），用于灰态高亮。 */
  answer?: string;
  onReply?: (text: string) => void;
}

/** ask_user 工具调用的结构化提问卡片：问题 + 选项按钮 + 自由输入。 */
export function AskUserCard({ input, interactive, answer, onReply }: AskUserCardProps) {
  const parsed = (input ?? {}) as AskUserInput;
  const [text, setText] = useState("");
  const options = (parsed.options ?? []).slice(0, 6);
  const allowFree = parsed.allowFreeText !== false;

  return (
    <div className={`ask-user-card${interactive ? "" : " answered"}`}>
      <div className="ask-user-question">{parsed.question ?? ""}</div>
      {options.length > 0 && (
        <div className="ask-user-options">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              className={`ask-user-option${answer === opt ? " chosen" : ""}`}
              disabled={!interactive}
              onClick={() => onReply?.(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      {interactive && allowFree && (
        <input
          className="ask-user-free"
          value={text}
          placeholder="或输入其他回答，Enter 发送"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim()) {
              onReply?.(text.trim());
              setText("");
            }
          }}
        />
      )}
    </div>
  );
}
