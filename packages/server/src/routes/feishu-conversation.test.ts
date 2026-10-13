import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createConversationRoutes, createGenerationRoutes } from "./conversations.js";

describe("persistent Feishu conversation",() => {
  it.each([["DELETE","/chat"],["PUT","/chat/project"],["POST","/chat/regenerate"],["POST","/chat/messages"],["POST","/chat/generations"]])("blocks %s %s from altering or truncating the channel transcript",async (method,path) => {
    const db={ getConversation:vi.fn(async () => ({ id:"chat",user_id:"owner",agent_id:"general",channel:"feishu" })) };
    const app=new Hono<{ Variables:{ userId:string } }>();
    app.use("*",async (c,next) => { c.set("userId","owner"); await next(); });
    app.route("/",createConversationRoutes({ db } as any));
    app.route("/",createGenerationRoutes({ db } as any));
    expect((await app.request(path,{ method,body:method==="DELETE" ? undefined : "{}" })).status).toBe(409);
  });
});
