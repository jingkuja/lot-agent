import { useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { shouldSubmitComposer } from "../lib/composer-keyboard.js";

export interface AskUserInput {
  question?: string;
  options?: string[];
  allowFreeText?: boolean;
  multiSelect?: boolean;
}

interface AskUserCardProps {
  input: unknown;
  /** 是否还在等待回答（是最后一次提问且未流式中）。 */
  interactive: boolean;
  /** 用户已给出的回答（其后第一条 user 消息），用于灰态高亮。 */
  answer?: string;
  onReply?: (text: string) => void;
}

/** 多选回答的分隔符 — 与 core 端 ask_user 工具描述里的约定一致。 */
const MULTI_SEP = "、";

/** 模型有时把候选答案当 Markdown 列表内联进 question 而漏填 options —
 * 匹配无序（-、*、+）或有序（1. / 1)）列表行，用于触发降级提示。 */
const BULLET_LIST_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)\S/m;

/** ask_user 工具调用的结构化提问卡片：问题 + 选项按钮 + 自由输入。 */
export function AskUserCard({ input, interactive, answer, onReply }: AskUserCardProps) {
  const compositionActiveRef = useRef(false);
  const parsed = (input ?? {}) as AskUserInput;
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const options = (parsed.options ?? []).slice(0, 6);
  const allowFree = parsed.allowFreeText !== false;
  const multi = parsed.multiSelect === true;
  // 降级：模型把候选项写进了 question 却没给 options —— 无可点选项时提示用户直接输入。
  const inlinedChoices =
    options.length === 0 && BULLET_LIST_RE.test(parsed.question ?? "");
  // 已回答时，多选的回答是「、」拼接的多个选项 — 逐段匹配做灰态高亮。
  const answerParts = answer ? answer.split(MULTI_SEP) : [];

  const submitMulti = () => {
    const parts = [...selected];
    const t = text.trim();
    if (t) parts.push(t);
    if (parts.length === 0) return;
    onReply?.(parts.join(MULTI_SEP));
    setText("");
  };

  const handleOption = (opt: string) => {
    if (!multi) {
      onReply?.(opt);
      return;
    }
    setSelected((prev) =>
      prev.includes(opt) ? prev.filter((o) => o !== opt) : [...prev, opt]
    );
  };

  return (
    <div className={`ask-user-card${interactive ? "" : " answered"}`}>
      <div className="ask-user-question markdown-body">
        <Markdown remarkPlugins={[remarkGfm]}>{parsed.question ?? ""}</Markdown>
      </div>
      {options.length > 0 && (
        <div className="ask-user-options">
          {options.map((opt) => {
            const chosen = interactive
              ? multi && selected.includes(opt)
              : answer === opt || answerParts.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                className={`ask-user-option${chosen ? " chosen" : ""}`}
                disabled={!interactive}
                onClick={() => handleOption(opt)}
              >
                {opt}
              </button>
            );
          })}
        </div>
      )}
      {interactive && inlinedChoices && (
        <div className="ask-user-hint">请在下方直接输入你的选择，可填多项。</div>
      )}
      {interactive && (allowFree || inlinedChoices) && (
        <input
          className={`ask-user-free${inlinedChoices ? " emphasized" : ""}`}
          value={text}
          placeholder={
            inlinedChoices
              ? "输入你的选择后按 Enter 发送"
              : multi
                ? "可补充其他回答，与所选项一并发送"
                : "或输入其他回答，Enter 发送"
          }
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => { compositionActiveRef.current = true; }}
          onCompositionEnd={() => { compositionActiveRef.current = false; }}
          onKeyDown={(e) => {
            if (!shouldSubmitComposer({
              key: e.key,
              shiftKey: e.shiftKey,
              isComposing: e.nativeEvent.isComposing,
              keyCode: e.nativeEvent.keyCode,
            }, compositionActiveRef.current)) return;
            if (multi) {
              submitMulti();
            } else if (text.trim()) {
              onReply?.(text.trim());
              setText("");
            }
          }}
        />
      )}
      {interactive && multi && (
        <button
          type="button"
          className="ask-user-submit"
          disabled={selected.length === 0 && !text.trim()}
          onClick={submitMulti}
        >
          发送{selected.length > 0 ? `（已选 ${selected.length} 项）` : ""}
        </button>
      )}
    </div>
  );
}
