import { useState, useEffect } from "react";
import { getWebhookInfo, submitWebhookMessage } from "../../api/concord";
import type { WebhookInfo } from "../../api/concord";
import { BringingUpSplash } from "../BringingUpSplash";

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
      <div className="min-h-screen bg-surface flex items-center justify-center overflow-y-auto">
        <BringingUpSplash size="compact" status="Loading…" />
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center overflow-y-auto">
        <div className="bg-surface-container border border-outline-variant/15 rounded-lg p-8 max-w-md w-full mx-4 text-center">
          <p className="text-error text-sm">{error || "Webhook not found"}</p>
        </div>
      </div>
    );
  }

  if (!info.enabled) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center overflow-y-auto">
        <div className="bg-surface-container border border-outline-variant/15 rounded-lg p-8 max-w-md w-full mx-4 text-center">
          <p className="text-on-surface-variant text-sm">This webhook is currently disabled.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface flex items-start sm:items-center justify-center p-4 overflow-y-auto">
      <div className="bg-surface-container border border-outline-variant/15 rounded-lg p-6 sm:p-8 max-w-lg w-full my-auto break-words min-w-0">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-on-surface">{info.name}</h1>
          <p className="text-sm text-on-surface-variant mt-1">
            Posting to <span className="text-on-surface-variant">#{info.channel_name}</span> in{" "}
            <span className="text-on-surface-variant">{info.server_name}</span>
          </p>
        </div>

        {submitted ? (
          <div className="space-y-4">
            <div className="bg-secondary/10 border border-secondary/15 rounded-md p-4">
              <p className="text-secondary text-sm">Message sent successfully!</p>
            </div>
            <button
              onClick={() => setSubmitted(false)}
              className="w-full px-4 py-2 bg-surface-container-highest hover:bg-surface-bright text-on-surface text-sm rounded transition-colors"
            >
              Send Another
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1">
                Name <span className="text-on-surface-variant/50 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Anonymous"
                maxLength={100}
                className="w-full px-3 py-2 bg-surface border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-on-surface mb-1">
                Message <span className="text-error">*</span>
              </label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Type your message..."
                maxLength={2000}
                rows={5}
                required
                className="w-full px-3 py-2 bg-surface border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/30 focus:outline-none focus:ring-1 focus:ring-primary/30 resize-none"
              />
              <p className="text-xs text-on-surface-variant/50 mt-1 text-right">
                {content.length}/2000
              </p>
            </div>

            {submitError && (
              <div className="bg-error/10 border border-error/30 rounded-md p-3">
                <p className="text-error text-sm">{submitError}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !content.trim()}
              className="w-full px-4 py-2.5 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm font-medium rounded transition-colors"
            >
              {submitting ? "Sending..." : "Send Message"}
            </button>
          </form>
        )}

        <p className="text-xs text-on-surface-variant/50 mt-6 text-center">
          Powered by Concord
        </p>
      </div>
    </div>
  );
}
