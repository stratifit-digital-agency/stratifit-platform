"use client";

import { useState } from "react";

export default function MessagePage({ params }: { params: Promise<{ handle: string }> }) {
  const [handle, setHandle] = useState<string>("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(true);

  if (pending) {
    // Resolve the async param on the client mount.
    void Promise.resolve(params).then(({ handle: h }) => {
      setHandle(h);
      setPending(false);
    });
  }

  const send = async () => {
    setStatus(null);
    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creatorHandle: handle, body }),
    });
    const data = (await res.json()) as {
      conversationId?: string;
      error?: { code?: string };
    };
    if (res.ok && data.conversationId) {
      setStatus("Conversation started. Our team can see it in the Control Room.");
    } else if (data.error?.code === "email_verification_required") {
      setStatus("Verify your email first — check your inbox for the link.");
    } else if (data.error?.code === "unauthenticated") {
      setStatus("Sign in to start a conversation.");
    } else {
      setStatus("Could not send the message.");
    }
  };

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-bold">Message @{handle || "…"}</h1>
      <p className="mt-2 text-sm text-gray-600">
        A conversation with this AI creator. Messages may be answered by the creator
        (AI) or by the Stratifit team — each is labeled.
      </p>
      <div className="mt-6 space-y-3">
        <textarea
          className="w-full rounded-md border border-gray-300 p-3 text-sm"
          rows={4}
          placeholder="Hi! I want a website like this…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <button
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          onClick={() => void send()}
        >
          Send
        </button>
        {status && <p className="text-sm text-gray-700">{status}</p>}
      </div>
    </main>
  );
}
