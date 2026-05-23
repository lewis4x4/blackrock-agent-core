// SPRINT 4: server-only. Reads/sends mail via the Microsoft Graph API using
// the tenant's OAuth access token from tenant_connections. Never bundle
// into a browser/UI build — service-role Supabase access required.

import type { Tool } from "../registry";
import { getConnectionAccessToken } from "./_connections";

interface M365MailInputList {
  action: "list";
  /** Number of messages to return, capped at MAX_LIMIT. */
  limit?: number;
  /** Microsoft Graph $search query (e.g. 'subject:invoice'). */
  search?: string;
}

interface M365MailInputSend {
  action: "send";
  to: string;
  subject: string;
  body: string;
  /** "Text" (default) or "HTML". */
  bodyType?: "Text" | "HTML";
}

type M365MailInput = M365MailInputList | M365MailInputSend;

interface M365MailListOutput {
  action: "list";
  messages: Record<string, unknown>[];
  count: number;
}

interface M365MailSendOutput {
  action: "send";
  ok: true;
}

type M365MailOutput = M365MailListOutput | M365MailSendOutput;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_BODY_CHARS = 100_000;
const REQUEST_TIMEOUT_MS = 30_000;

// Permissive RFC-5322-ish address check. We're not the SMTP server — the IdP
// will reject genuinely malformed addresses. This is just a sanity guard.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Built-in: read/send mail via Microsoft Graph using the tenant's OAuth
 * connection. The `action` field discriminates between read-only `list` and
 * the side-effectful `send`.
 *
 * The tool is intentionally minimal — no rich folder selection, no
 * attachments. Wider Graph coverage can be a separate tool.
 */
export const m365Mail: Tool = {
  key: "m365_mail",
  description:
    "Read or send Microsoft 365 mail for the tenant. Input: { action: 'list', limit?, search? } OR { action: 'send', to, subject, body, bodyType? }. Returns { messages, count } or { ok: true }.",
  async run(rawInput, ctx) {
    const input = rawInput as unknown as M365MailInput;
    const action = (input as { action?: string })?.action;
    if (action !== "list" && action !== "send") {
      throw new Error("m365_mail: action must be 'list' or 'send'");
    }

    const tenantId = String(ctx?.tenantId ?? "");
    if (!tenantId) throw new Error("m365_mail: ctx.tenantId is required");

    // Validate action-specific inputs BEFORE resolving the connection so we
    // never round-trip to Supabase for a request we'd reject anyway.
    if (action === "send") {
      validateSendInput(input as M365MailInputSend);
    }

    const accessToken = await getConnectionAccessToken(tenantId, "m365");

    if (action === "list") {
      return listMessages(input as M365MailInputList, accessToken);
    }
    return sendMessage(input as M365MailInputSend, accessToken);
  },
};

function validateSendInput(input: M365MailInputSend): void {
  const to = String(input.to ?? "").trim();
  const subject = String(input.subject ?? "");
  const body = String(input.body ?? "");
  if (!EMAIL.test(to)) throw new Error("m365_mail: invalid 'to' address");
  if (!subject) throw new Error("m365_mail: subject is required");
  if (!body) throw new Error("m365_mail: body is required");
  if (body.length > MAX_BODY_CHARS) {
    throw new Error(`m365_mail: body exceeds ${MAX_BODY_CHARS} chars`);
  }
}

async function listMessages(
  input: M365MailInputList,
  accessToken: string
): Promise<M365MailListOutput> {
  const requestedLimit = Number.isFinite(input.limit)
    ? Number(input.limit)
    : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requestedLimit)));

  const url = new URL("https://graph.microsoft.com/v1.0/me/messages");
  url.searchParams.set("$top", String(limit));
  url.searchParams.set(
    "$select",
    "id,subject,from,receivedDateTime,bodyPreview,hasAttachments"
  );
  if (input.search && typeof input.search === "string") {
    // Graph's $search clause needs to be a quoted string per its docs.
    url.searchParams.set("$search", `"${input.search.replace(/"/g, '\\"')}"`);
  }

  const res = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      // $search requires ConsistencyLevel: eventual on the messages endpoint.
      ...(input.search ? { ConsistencyLevel: "eventual" } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`m365_mail list: ${res.status}: ${text.slice(0, 400)}`);
  }
  const payload = (await res.json()) as { value?: unknown };
  const rawMessages = Array.isArray(payload?.value) ? payload.value : [];
  const messages = rawMessages.slice(0, limit) as Record<string, unknown>[];

  return { action: "list", messages, count: messages.length };
}

async function sendMessage(
  input: M365MailInputSend,
  accessToken: string
): Promise<M365MailSendOutput> {
  // validateSendInput already ran in the tool entry — refetch the normalized
  // fields here to keep this helper self-contained.
  const to = String(input.to).trim();
  const subject = String(input.subject);
  const body = String(input.body);
  const bodyType = input.bodyType === "HTML" ? "HTML" : "Text";

  const payload = {
    message: {
      subject,
      body: { contentType: bodyType, content: body },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: true,
  };

  const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // Graph returns 202 Accepted on sendMail.
  if (res.status !== 202 && !res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`m365_mail send: ${res.status}: ${text.slice(0, 400)}`);
  }

  return { action: "send", ok: true };
}

export type { M365MailOutput };

// [PART 4 — m365_mail COMPLETE]
