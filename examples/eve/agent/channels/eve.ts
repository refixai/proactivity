// A minimal HTTP channel so this is a complete, deployable Eve app. The demo is
// driven by the schedule rather than inbound HTTP, so anonymous auth is fine.
import { none } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({ auth: [none()] });
