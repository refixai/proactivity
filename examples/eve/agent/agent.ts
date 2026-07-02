import { defineAgent } from "eve";

// Identity is derived from the package name; tools, hooks, schedules, and
// channels are discovered from the filesystem, so this stays minimal.
//
// A bare model id routes through the Vercel AI Gateway; run `eve link` (or set
// AI_GATEWAY_API_KEY) so Eve can reach it. modelContextWindowTokens is set so
// the app also compiles offline without a gateway lookup for the model's
// metadata; drop it once you're linked to a gateway that knows the model. To
// use a provider directly instead of the gateway, see the README.
export default defineAgent({
  model: "anthropic/claude-opus-4-8",
  modelContextWindowTokens: 200_000,
});
