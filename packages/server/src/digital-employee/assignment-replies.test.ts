import { describe, expect, it } from "vitest";
import { isContinueReply, matchDecisionReply, quotedReply } from "./assignment-replies.js";

const question = { kind: "question" as const, options: ["华东的王总", "华南的王总", "都不是"], multiSelect: false };
const multiple = { ...question, multiSelect: true };
const failure = { kind: "failure" as const, options: ["retry", "skip", "change", "end"], multiSelect: false };

describe("matchDecisionReply", () => {
  it.each([["1", "华东的王总"], ["1.", "华东的王总"], ["１", "华东的王总"], ["第二个", "华南的王总"], ["第2个", "华南的王总"], ["选3", "都不是"], ["选项 2", "华南的王总"], ["二", "华南的王总"]])(
    "reads %s as an option's number", (text, answer) => {
      expect(matchDecisionReply(text, question)).toEqual({ text: answer });
    },
  );

  it("reads an option's own words, however they are punctuated", () => {
    expect(matchDecisionReply(" 华南的王总。 ", question)).toEqual({ text: "华南的王总" });
  });

  it("does not guess at a number out of range or a sentence", () => {
    for (const text of ["4", "0", "第九个", "华东那位吧", "继续", "好的", "1000", "明天1点开会"]) {
      expect(matchDecisionReply(text, question)).toBeNull();
    }
  });

  it("takes several choices only where the question allows them", () => {
    expect(matchDecisionReply("1、3", multiple)).toEqual({ text: "华东的王总、都不是" });
    expect(matchDecisionReply("1 2", multiple)).toEqual({ text: "华东的王总、华南的王总" });
    expect(matchDecisionReply("1 1", multiple)).toEqual({ text: "华东的王总" });
    expect(matchDecisionReply("1、3", question)).toBeNull();
    expect(matchDecisionReply("1、9", multiple)).toBeNull();
  });

  it.each([
    ["1", "retry"], ["重试", "retry"], ["再试一次", "retry"], ["继续", "retry"], ["Retry!", "retry"],
    ["2", "skip"], ["跳过", "skip"], ["3", "change"], ["换个做法", "change"], ["4", "end"], ["结束", "end"], ["结束任务", "end"], ["第四个", "end"],
  ])("reads %s as %s on a failure", (text, choice) => {
    expect(matchDecisionReply(text, failure)).toEqual({ choice });
  });

  it("leaves ordinary chat alone on a failure", () => {
    for (const text of ["5", "结束了吗", "我想重试一下别的", "你好"]) expect(matchDecisionReply(text, failure)).toBeNull();
  });
});

describe("quotedReply", () => {
  it("prefers a real match, and keeps anything else as the owner's words", () => {
    expect(quotedReply("2", question)).toEqual({ text: "华南的王总" });
    expect(quotedReply("华东那位，电话尾号 88", question)).toEqual({ text: "华东那位，电话尾号 88" });
    expect(quotedReply("跳过", failure)).toEqual({ choice: "skip" });
    expect(quotedReply("别用搜索了，用资料里的", failure)).toEqual({ choice: "change", text: "别用搜索了，用资料里的" });
  });
});

describe("isContinueReply", () => {
  it("only takes a plain continue", () => {
    for (const text of ["继续", "继续。", "继续吧", "接着做", "Continue"]) expect(isContinueReply(text)).toBe(true);
    for (const text of ["继续写周报", "不要继续", "1"]) expect(isContinueReply(text)).toBe(false);
  });
});
