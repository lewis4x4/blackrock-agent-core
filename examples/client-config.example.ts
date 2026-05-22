// Example per-client config. Lives in the CLIENT repo, not in agent-core.
// Adding a new client = one file like this. No change to Agent Core.

import {
  Home,
  Workflow,
  FolderOpen,
  FileSpreadsheet,
  Brain,
  MessageSquare,
  Database,
  Mail,
} from "lucide-react";
import type { TenantConfig } from "@blackrock/agent-core";

export const qepConfig: TenantConfig = {
  id: "qep",
  brand: "QEP USA",
  product: "QEP AI Workspace",
  tagline: "One platform. Every department. Built for the field.",
  accent: "#C98A4A",
  nav: [
    { id: "home", label: "Home", Icon: Home },
    { id: "deals", label: "Deals", Icon: Workflow },
    { id: "drive", label: "Drive", Icon: FolderOpen },
  ],
  categories: [
    {
      label: "Sales",
      groups: [
        {
          tools: [
            { name: "Quote Builder", Icon: FileSpreadsheet, tint: "#E0913B", kind: "ai" },
            { name: "Deal Genome", Icon: Brain, tint: "#8B7BD8", kind: "ai" },
          ],
        },
      ],
    },
    {
      label: "Intelligence",
      groups: [
        {
          tools: [
            { name: "Knowledge Chat", Icon: MessageSquare, tint: "#4D9FE6", kind: "ai" },
          ],
        },
      ],
    },
    {
      label: "Connected",
      groups: [
        {
          label: "Their subscriptions",
          tools: [
            { name: "HubSpot CRM", Icon: Database, tint: "#7E8493", kind: "connected", source: "HubSpot" },
            { name: "Microsoft 365", Icon: Mail, tint: "#7E8493", kind: "connected", source: "Outlook" },
          ],
        },
      ],
    },
  ],
};
