export const MEDIA_UNAVAILABLE = "后续支持，持续开发中...";

// Fast path; the text-only agent handles semantic variants with the same fixed response.
export function isMediaGeneration(text: string): boolean {
  if (/^\/(send|reply|发给|回复)\s/u.test(text)) return false;
  if (/(提示词|脚本|文案|分镜|prompt|script)/iu.test(text) && !/(并|再|然后|同时|and|then).{0,10}(生成|制作|generate|create)/iu.test(text)) return false;
  return /(?:生成|制作|画|绘制|做|出|剪辑|渲染).{0,24}(?:图片|图像|照片|海报|插画|视频|短片|动画|图|像)/u.test(text)
    || /(?:图片|图像|视频).{0,8}(?:生成|制作|创作)/u.test(text)
    || /\b(?:generate|create|draw|make|render|edit)\b.{0,50}\b(?:image|picture|photo|poster|illustration|video|animation)\b/iu.test(text);
}

export type SendCommand = { recipient: string; text: string; reply?: boolean };
export function parseSendCommand(text: string): SendCommand | null {
  const direct = text.match(/^\/(send|发给|reply|回复)\s+(\S+)\s+([\s\S]+)$/u);
  if (direct) return { recipient: direct[2]!, text: direct[3]!, reply: ["reply", "回复"].includes(direct[1]!) };
  const natural = text.match(/^(?:请帮我|帮我|请)?(?:给|发给)\s*(.{1,40}?)\s*(?:发送|发消息|发|说)?\s*[：:]\s*([\s\S]+)$/u);
  return natural ? { recipient: natural[1]!.trim(), text: natural[2]! } : null;
}

export const FEISHU_TEXT_POLICY = `This is the Feishu text-only channel. You have no execution, file, image or video generation tools.
For ANY request to generate or edit an actual image/video, reply exactly: ${MEDIA_UNAVAILABLE}
Writing prompts, scripts or other text is supported. Never claim that a message was sent or a computer task executed.
For sending messages, explain the syntax /send <saved contact alias or open_id> <exact text>.
For replying to a specific message, explain /reply <message_id> <exact text>.
Remote local-computer tools are not enabled in this first release. Explain this if asked to operate the computer.`;
