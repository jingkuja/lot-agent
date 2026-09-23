import { expect, it } from "vitest";
import { knowledgeContentPolicy } from "./content-policy.js";

it("previews supported passive media while isolating active content", () => {
  for (const mime of ["audio/wav", "audio/mp4", "video/webm", "video/mp4", "application/pdf", "image/png"]) {
    expect(knowledgeContentPolicy(mime)).toEqual({ contentType: mime, disposition: "inline" });
  }
  for (const mime of ["text/html", "image/svg+xml", "application/javascript"]) {
    expect(knowledgeContentPolicy(mime)).toEqual({ contentType: "application/octet-stream", disposition: "attachment" });
  }
});
