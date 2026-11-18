import type { ComicFrozenGenerationInput, ComicGenerationProvider, ComicPollReceipt, ComicSubmitReceipt } from "./generation.js";

/** Retains a deterministic call log for no-network submission and recovery checks. */
export class FakeComicGenerationProvider implements ComicGenerationProvider {
  readonly submissions: ComicFrozenGenerationInput[] = [];
  readonly polls: string[] = [];
  private nextPoll = 0;

  constructor(private readonly receipt: ComicSubmitReceipt, private readonly states: readonly ComicPollReceipt[] = []) {}

  async submit(input: ComicFrozenGenerationInput, signal?: AbortSignal): Promise<ComicSubmitReceipt> {
    signal?.throwIfAborted();
    this.submissions.push(structuredClone(input));
    return this.receipt;
  }

  async poll(id: string, signal?: AbortSignal): Promise<ComicPollReceipt> {
    signal?.throwIfAborted();
    if (this.receipt.state !== "accepted" || this.receipt.providerTaskId !== id) throw new Error("Unknown fixture task");
    this.polls.push(id);
    const state = this.states[Math.min(this.nextPoll, this.states.length - 1)];
    this.nextPoll += 1;
    return state ?? { state: "processing" };
  }
}
