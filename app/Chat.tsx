"use client";

/**
 * The Chat tab: the group message for one mixer.
 *
 * Deliberately not a messaging app. There is no typing indicator, no read
 * receipt, no reply threading and no editing, because the conversation it
 * carries lasts one morning and is mostly logistics: which court is short,
 * who has a spare grip, where coffee is afterwards. What it does need is to be
 * usable one-handed, between points, on a phone in the sun.
 *
 * Identity is the name the member already picked on the Schedule tab to find
 * their own court, so there is nothing extra to fill in. Nobody who has not
 * picked one is blocked from talking; their messages are signed Anonymous.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  ANONYMOUS,
  MAX_MESSAGE_LENGTH,
  cleanText,
  fmtWhen,
  sortMessages,
  startsRun,
  type ChatMessage,
} from "@/lib/chat";

/** How often the conversation is refreshed while the tab is open. */
const POLL_MS = 10000;

export default function Chat({
  eventId,
  /** The name picked on the Schedule tab, if any. Signs what they send. */
  meName,
}: {
  eventId: string;
  meName?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const foot = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  /** Whether the reader is at the bottom, so a poll does not yank them there. */
  const atBottom = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/chat`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not load the chat.");
      setMessages(sortMessages(body.messages ?? []));
      setError("");
    } catch (e) {
      setMessages((m) => m ?? []);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [eventId]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await refresh();
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refresh]);

  // Follow the conversation down only when the reader was already at the
  // bottom. Somebody scrolled up reading what they missed should stay there.
  useEffect(() => {
    if (atBottom.current) foot.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  async function send() {
    const text = cleanText(draft);
    if (!text || sending) return;
    setSending(true);
    setError("");
    try {
      const res = await fetch(`/api/events/${eventId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, by: meName }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "That message could not be sent.");
      atBottom.current = true;
      setMessages((m) => sortMessages([...(m ?? []), body.message as ChatMessage]));
      setDraft("");
      box.current?.focus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Return sends, shift-return makes a new line. On a phone the on-screen
    // keyboard sends its own newline, which this reads the same way.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const left = MAX_MESSAGE_LENGTH - draft.length;

  return (
    <section className="flex flex-col">
      <p className="mb-2 text-xs opacity-60">
        Everyone at this mixer can read this.{" "}
        {meName ? (
          <>
            You are posting as <span className="font-medium opacity-100">{meName}</span>.
          </>
        ) : (
          <>
            Pick your name on the Schedule tab to sign your messages, or post as {ANONYMOUS}.
          </>
        )}
      </p>

      <div
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="max-h-[55vh] min-h-[220px] overflow-y-auto rounded-xl border border-black/10 p-3 dark:border-white/15"
      >
        {messages === null ? (
          <p className="text-sm opacity-60">Loading the chat…</p>
        ) : messages.length === 0 ? (
          <div className="py-10 text-center">
            <div className="text-3xl">💬</div>
            <p className="mt-2 text-sm font-medium">Nothing said yet</p>
            <p className="mt-1 text-xs opacity-60">
              Say hello, ask who is on which court, or sort out coffee afterwards.
            </p>
          </div>
        ) : (
          <ol className="space-y-1">
            {messages.map((m, i) => {
              const mine = Boolean(meName) && m.by === meName;
              const heads = startsRun(m, messages[i - 1]);
              return (
                <li key={m.id} className={heads ? "pt-2 first:pt-0" : ""}>
                  {heads && (
                    <p className="mb-0.5 flex items-baseline gap-2 text-xs">
                      <span className="font-semibold">{mine ? "You" : m.by}</span>
                      <span className="opacity-50">{fmtWhen(m.at)}</span>
                    </p>
                  )}
                  {/* whitespace-pre-wrap keeps the line breaks somebody typed;
                      break-words stops a pasted URL widening the whole column. */}
                  <p
                    className={`w-fit max-w-full rounded-2xl px-3 py-1.5 text-sm break-words whitespace-pre-wrap ${
                      mine
                        ? "bg-blue-600 text-white"
                        : "bg-black/[0.06] dark:bg-white/[0.10]"
                    }`}
                  >
                    {m.text}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
        <div ref={foot} />
      </div>

      {error && (
        <p className="mt-2 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}

      <div className="mt-3 flex items-end gap-2">
        <textarea
          ref={box}
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, MAX_MESSAGE_LENGTH))}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Message everyone at the mixer…"
          className="min-h-[46px] flex-1 resize-y rounded-xl border border-black/15 px-3 py-2 text-base dark:border-white/20 dark:bg-transparent"
        />
        <button
          onClick={send}
          disabled={sending || !cleanText(draft)}
          className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-40 dark:hover:bg-blue-500"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      {/* Only worth showing once it is close enough to matter. */}
      {left < 80 && <p className="mt-1 text-right text-xs opacity-50">{left} left</p>}
    </section>
  );
}
