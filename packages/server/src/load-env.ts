/**
 * Side-effect module: load repo-root `.env` before any other startup code
 * reads process.env. Must be the first import of server/worker entrypoints.
 */
import { loadRepoEnv } from "./env-file.js";

loadRepoEnv();
