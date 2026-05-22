// Narrow media store helpers for channel runtimes that do not need the full media runtime.

export {
  readMediaBuffer,
  resolveMediaBufferPath,
  saveMediaBuffer,
  saveMediaStream,
} from "../media/store.js";
export type { SavedMedia } from "../media/store.js";

/**
 * Subdir under the media root used by agent tools that render media (QR codes,
 * screenshots, generated charts) for inline display in the chat UI. Kept in a
 * named subdir so the periodic TTL sweep applies and so the gateway media
 * endpoint can scope its reads.
 *
 * The model never sees the bytes — it sees only `/api/media/agent-output/<id>`,
 * which it can reproduce verbatim. This is the load-bearing fact: small/
 * quantized local models cannot reliably re-emit multi-KB random base64.
 */
export const AGENT_TOOL_MEDIA_SUBDIR = "agent-tool-output";

/** Path prefix for the gateway endpoint that serves agent-tool media. */
export const AGENT_TOOL_MEDIA_URL_PREFIX = "/api/media/agent-output/";

/** Format a media id returned by {@link saveMediaBuffer} into the chat-display URL. */
export function formatAgentToolMediaUrl(id: string): string {
  return `${AGENT_TOOL_MEDIA_URL_PREFIX}${encodeURIComponent(id)}`;
}
