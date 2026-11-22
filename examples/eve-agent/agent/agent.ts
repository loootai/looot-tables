import { defineAgent } from "eve";
import { anthropic } from "eve/models/anthropic";
import { openai } from "eve/models/openai";

/** Claude Sonnet 5.5 on your Anthropic key, or your OpenAI model when only an OpenAI key is set. No shell, files or open
    web: the agent's only tools are the looot tables connection (and the optional looot one), so it needs no sandbox. */
export default defineAgent({
  defaultTools: false,
  model: process.env.ANTHROPIC_API_KEY ? anthropic("claude-sonnet-5-5") : openai(process.env.OPENAI_MODEL || undefined),
});
