export type SendCommand = { recipient: string; text: string; reply?: boolean };
export function parseSendCommand(text: string): SendCommand | null {
  const direct = text.match(/^\/(send|发给|reply|回复)\s+(\S+)\s+([\s\S]+)$/u);
  if (direct) return { recipient: direct[2]!, text: direct[3]!, reply: ["reply", "回复"].includes(direct[1]!) };
  const natural = text.match(/^(?:请帮我|帮我|请)?(?:给|发给)\s*(.{1,40}?)\s*(?:发送|发消息|发|说)?\s*[：:]\s*([\s\S]+)$/u);
  return natural ? { recipient: natural[1]!.trim(), text: natural[2]! } : null;
}

export const FEISHU_TEXT_POLICY = `This conversation is delivered through Feishu. All tools available to the Web Agent are available here; use them normally for research, documents, presentations, generation and delegation.
Use ask_user or propose_outline when a user reply or approval is needed. Their questions/options/outlines are delivered as text in Feishu; the next user message is their reply. Never claim to show clickable Feishu controls.
Use the successful tool results as evidence. File download links are delivered by the channel from tool receipts; do not invent URLs. The complete results and interactive cards are also saved in the Lot Agent Feishu conversation.
Only claim a message was sent after a successful tool receipt. Desktop local-computer tools still require a desktop workspace connection and are not available in this channel.`;
