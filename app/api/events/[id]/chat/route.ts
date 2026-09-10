/**
 * GET    /api/events/<id>/chat - the conversation
 * POST   /api/events/<id>/chat - say something
 * DELETE /api/events/<id>/chat - remove one message, or clear the lot (organiser)
 *
 * Posting is open, like entering a score and adding a photo, and for the same
 * reason: the people at the mixer are the people with the link, and a login
 * would cost the club more than it protects. Deleting is the organiser's alone.
 */
import { isAdminRequest } from "@/lib/admin";
import {
  ANONYMOUS,
  checkMessage,
  cleanName,
  isValidMessageId,
  newMessageId,
  type ChatMessage,
} from "@/lib/chat";
import {
  addMessage,
  clearChat,
  deleteMessage,
  getEvent,
  isStoreConfigured,
  isValidEventId,
  listMessages,
  normalizeEventId,
  StoreUnavailableError,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "cache-control": "no-store" } };

async function codeFrom(params: Promise<{ id: string }>) {
  const { id } = await params;
  const code = normalizeEventId(id);
  return isValidEventId(code) ? code : null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const code = await codeFrom(ctx.params);
  if (!code) return Response.json({ error: "That is not a valid event code." }, { status: 400 });
  if (!isStoreConfigured()) return Response.json({ messages: [] }, noStore);
  try {
    return Response.json({ messages: await listMessages(code) }, noStore);
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const code = await codeFrom(ctx.params);
  if (!code) return Response.json({ error: "That is not a valid event code." }, { status: 400 });
  if (!isStoreConfigured()) {
    return Response.json({ error: "Chat is not configured on this deployment." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { text, by } = (body ?? {}) as { text?: unknown; by?: unknown };

  let existing: ChatMessage[];
  try {
    existing = await listMessages(code);
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  // The same rules the browser applied, applied again. What the client checked
  // is not a check.
  const verdict = checkMessage({ text, existingCount: existing.length });
  if (!verdict.ok) return Response.json({ error: verdict.error }, { status: 400 });

  if (!(await getEvent(code))) {
    return Response.json({ error: "No event with that code." }, { status: 404 });
  }

  const message: ChatMessage = {
    id: newMessageId(),
    at: Date.now(),
    by: cleanName(by) || ANONYMOUS,
    text: verdict.text,
  };

  try {
    await addMessage(code, message);
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    console.error("addMessage failed", err);
    return Response.json({ error: "That message could not be sent." }, { status: 500 });
  }
  return Response.json({ message }, { status: 201, ...noStore });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const code = await codeFrom(ctx.params);
  if (!code) return Response.json({ error: "That is not a valid event code." }, { status: 400 });
  if (!isAdminRequest(request)) {
    return Response.json({ error: "Organisers only." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { message, all } = (body ?? {}) as { message?: unknown; all?: unknown };

  try {
    // Clearing the whole conversation is the only way out of a full chat, so it
    // exists, but it has to be asked for explicitly rather than being what an
    // empty body happens to do.
    if (all === true) {
      await clearChat(code);
    } else if (isValidMessageId(message)) {
      await deleteMessage(code, message);
    } else {
      return Response.json({ error: "Which message?" }, { status: 400 });
    }
    return Response.json({ messages: await listMessages(code) }, noStore);
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    console.error("chat delete failed", err);
    return Response.json({ error: "That could not be removed." }, { status: 500 });
  }
}
