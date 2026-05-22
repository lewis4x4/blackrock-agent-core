# examples

`client-config.example.ts` shows the ONE file a client app needs to use
Agent Core. It lives in the client repo (e.g. `qep-os/src/agent/agent.config.ts`),
never in agent-core.

The host app then renders:

```tsx
import { Workspace } from "@blackrock/agent-core";
import { qepConfig } from "./agent.config";

<Workspace
  config={qepConfig}
  onLaunch={(tool) => routeTo(tool)}
  onSend={(query, model) => callAgentRuntime(query, model)}
/>
```
