import { useState, useEffect } from "react";
import { getWebhookInfo, submitWebhookMessage } from "../../api/concorrd";
import type { WebhookInfo } from "../../api/concorrd";

interface Props {
  webhookId: string;
}

export function SubmitPage({ webhookId }: Props) {
  const [info, setInfo] = useState<WebhookInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [username, setUsername] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await getWebhookInfo(webhookId);
        setInfo(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Webhook not found");
      } finally {
        setLoading(false);
      }
    })();
  }, [webhookId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      await submitWebhookMessage(webhookId, content.trim(), username.trim() || undefined);
      setSubmitted(true);
      setContent("");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-900 flex items-center justify-center">
        <span className="text-zinc-500">Loading...</span>
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="min-h-screen bg-zinc-900 flex items-center justify-center">
        <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-8 max-w-md w-full mx-4 text-center">
          <p className="text-red-400 text-sm">{error || "Webhook not found"}</p>
        </div>
      </div>
    );
  }

  if (!info.enabled) {
    return (
      <div className="min-h-screen bg-zinc-900 flex items-center justify-center">
        <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-8 max-w-md w-full mx-4 text-center">
          <p className="text-zinc-400 text-sm">This webhook is currently disabled.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-900 flex items-center justify-center p-4">
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-8 max-w-lg w-full">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-white">{info.name}</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Posting to <span className="text-zinc-400">#{info.channel_name}</span> in{" "}
            <span className="text-zinc-400">{info.server_name}</span>
          </p>
        </div>

        {submitted ? (
          <div className="space-y-4">
            <div className="bg-emerald-600/10 border border-emerald-600/30 rounded-md p-4">
              <p className="text-emerald-400 text-sm">Message sent successfully!</p>
            </div>
            <button
              onClick={() => setSubmitted(false)}
              className="w-full px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded transition-colors"
            >
              Send Another
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">
                Name <span className="text-zinc-600 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Anonymous"
                maxLength={100}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-600 rounded text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">
                Message <span className="text-red-400">*</span>
              </label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Type your message..."
                maxLength={2000}
                rows={5}
                required
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-600 rounded text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500 resize-none"
              />
              <p className="text-xs text-zinc-600 mt-1 text-right">
                {content.length}/2000
              </p>
            </div>

            {submitError && (
              <div className="bg-red-600/10 border border-red-600/30 rounded-md p-3">
                <p className="text-red-400 text-sm">{submitError}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !content.trim()}
              className="w-full px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded transition-colors"
            >
              {submitting ? "Sending..." : "Send Message"}
            </button>
          </form>
        )}

        <p className="text-xs text-zinc-600 mt-6 text-center">
          Powered by Concord
        </p>
      </div>
    </div>
  );
}
