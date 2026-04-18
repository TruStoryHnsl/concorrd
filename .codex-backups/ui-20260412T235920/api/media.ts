/**
 * Convert mxc:// URLs to authenticated HTTP URLs via the Concord media proxy.
 *
 * The proxy at /api/media/ accepts the token as a short query parameter and
 * forwards requests to the Matrix homeserver with proper Authorization headers.
 * This keeps the full access_token out of Matrix endpoint URLs, limiting
 * exposure to same-origin internal proxy routes only.
 */

import { getApiBase } from "./serverUrl";

const MXC_REGEX = /^mxc:\/\/([^/]+)\/(.+)$/;

/**
 * Convert an mxc:// URL to an authenticated HTTP download URL via the proxy.
 * Returns null if the input isn't a valid mxc:// URL or accessToken is missing.
 */
export function mxcToHttp(
  mxcUrl: string,
  accessToken: string | null,
): string | null {
  if (!accessToken) return null;
  const match = mxcUrl.match(MXC_REGEX);
  if (!match) return null;
  const [, serverName, mediaId] = match;
  return `${getApiBase()}/media/download/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}?token=${encodeURIComponent(accessToken)}`;
}

/**
 * Convert an mxc:// URL to an authenticated thumbnail URL via the proxy.
 */
export function mxcToThumbnail(
  mxcUrl: string,
  accessToken: string | null,
  width: number,
  height: number,
  method: "crop" | "scale" = "crop",
): string | null {
  if (!accessToken) return null;
  const match = mxcUrl.match(MXC_REGEX);
  if (!match) return null;
  const [, serverName, mediaId] = match;
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    method,
    token: accessToken,
  });
  return `${getApiBase()}/media/thumbnail/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}?${params}`;
}
