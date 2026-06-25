/** Three-dot bounce animation shown while awaiting the model's next output
 *  (initial reply, tool execution, or the turn after a tool result). */
export function TypingDots() {
  return (
    <span className="typing-indicator" role="status" aria-label="正在处理">
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </span>
  );
}
