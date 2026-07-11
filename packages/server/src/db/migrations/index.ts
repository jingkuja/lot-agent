import type { Migration } from "../migration-runner.js";
import { baseline } from "./0001-baseline.js";
import { messageSeq } from "./0002-message-seq.js";

// Static array (no fs scan — dynamic directory scanning isn't reliable once
// this ships through tsup's bundling). To add a migration: create
// `NNNN-name.ts` exporting a `Migration`, import it here, and append it.
export const migrations: Migration[] = [baseline, messageSeq];
