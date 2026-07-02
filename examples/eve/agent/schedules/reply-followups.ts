// The Eve-native proactive trigger. Eve's own cron wakes the agent; proactivity
// adds the governance envelope, the durable goal, and the audit ledger on top.
//
// The markdown prompt is the whole tick instruction — by the time the model
// runs, the session.started hook (hooks/open-tick.ts) has already opened the
// tick (goal, goal-tick, governance) and seeded the state the tools read.
import { defineSchedule } from "eve/schedules";

export default defineSchedule({
  cron: "*/5 * * * *",
  markdown: [
    "A proactive tick has fired.",
    "Call list_pending_replies to see conversations I've left on read.",
    "For each one, call send_followup_nudge once to remind me to reply.",
    "If there are none, take no action.",
  ].join(" "),
});
