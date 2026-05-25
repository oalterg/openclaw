import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authorizeGatewayHttpRequestOrReplyMock = vi.fn();
const resolveOpenAiCompatibleHttpOperatorScopesMock = vi.fn();
const resolveOpenAiCompatibleHttpSenderIsOwnerMock = vi.fn();
const readMediaBufferMock = vi.fn();

vi.mock("./http-utils.js", () => ({
  authorizeGatewayHttpRequestOrReply: authorizeGatewayHttpRequestOrReplyMock,
  resolveOpenAiCompatibleHttpOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopesMock,
  resolveOpenAiCompatibleHttpSenderIsOwner: resolveOpenAiCompatibleHttpSenderIsOwnerMock,
}));

vi.mock("../media/store.js", () => ({
  readMediaBuffer: readMediaBufferMock,
}));

const { handleAgentToolMediaHttpRequest, isAgentToolMediaPath } =
  await import("./agent-tool-media.js");

type RequestResult = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

async function callEndpoint(params: {
  pathName: string;
  method?: string;
  scopes?: string[];
  isOwner?: boolean;
  denyAuth?: boolean;
}): Promise<RequestResult> {
  authorizeGatewayHttpRequestOrReplyMock.mockImplementation(async ({ res }) => {
    if (params.denyAuth) {
      res.statusCode = 401;
      res.end();
      return null;
    }
    return { ok: true, authMethod: "token" };
  });
  resolveOpenAiCompatibleHttpOperatorScopesMock.mockReturnValue(params.scopes ?? ["operator.read"]);
  resolveOpenAiCompatibleHttpSenderIsOwnerMock.mockReturnValue(params.isOwner ?? true);

  const auth = { mode: "test" } as never;
  const server = http.createServer(async (req, res) => {
    const handled = await handleAgentToolMediaHttpRequest(req, res, {
      auth,
      trustedProxies: ["127.0.0.1/32"],
      allowRealIpFallback: false,
    });
    if (!handled) {
      res.statusCode = 404;
      res.end("unhandled");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    return await new Promise<RequestResult>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: params.pathName,
          method: params.method ?? "GET",
        },
        async (res) => {
          const chunks: Buffer[] = [];
          for await (const chunk of res) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

beforeEach(() => {
  authorizeGatewayHttpRequestOrReplyMock.mockReset();
  resolveOpenAiCompatibleHttpOperatorScopesMock.mockReset();
  resolveOpenAiCompatibleHttpSenderIsOwnerMock.mockReset();
  readMediaBufferMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("isAgentToolMediaPath", () => {
  it("matches the canonical prefix", () => {
    expect(isAgentToolMediaPath("/api/media/agent-output/abc.png")).toBe(true);
  });

  it("rejects unrelated paths", () => {
    expect(isAgentToolMediaPath("/api/chat/media/outgoing/x")).toBe(false);
    expect(isAgentToolMediaPath("/api/media/agent-input/abc.png")).toBe(false);
    expect(isAgentToolMediaPath("/")).toBe(false);
  });
});

describe("handleAgentToolMediaHttpRequest", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");

  it("serves stored media bytes to an authorized owner", async () => {
    readMediaBufferMock.mockResolvedValueOnce({
      id: "abc.png",
      path: "/fake/abc.png",
      buffer: png,
      size: png.byteLength,
    });

    const res = await callEndpoint({ pathName: "/api/media/agent-output/abc.png" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-length"]).toBe(String(png.byteLength));
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.body.equals(png)).toBe(true);
    expect(readMediaBufferMock).toHaveBeenCalledWith("abc.png", "agent-tool-output");
  });

  it("returns 404 when the id includes a path traversal segment", async () => {
    const res = await callEndpoint({ pathName: "/api/media/agent-output/..%2Fevil" });
    expect(res.statusCode).toBe(404);
    expect(readMediaBufferMock).not.toHaveBeenCalled();
  });

  it("returns 404 for an unsupported extension", async () => {
    const res = await callEndpoint({ pathName: "/api/media/agent-output/secret.txt" });
    expect(res.statusCode).toBe(404);
    expect(readMediaBufferMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the file is missing on disk", async () => {
    readMediaBufferMock.mockRejectedValueOnce(new Error("readMediaBuffer: not found"));
    const res = await callEndpoint({ pathName: "/api/media/agent-output/missing.png" });
    expect(res.statusCode).toBe(404);
  });

  it("serves media without auth (UUID filenames are unguessable)", async () => {
    readMediaBufferMock.mockResolvedValueOnce({
      id: "abc.png",
      path: "/fake/abc.png",
      buffer: png,
      size: png.byteLength,
    });

    const res = await callEndpoint({
      pathName: "/api/media/agent-output/abc.png",
      denyAuth: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
  });

  it("returns 405 for non-GET methods", async () => {
    const res = await callEndpoint({
      pathName: "/api/media/agent-output/abc.png",
      method: "POST",
    });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toContain("GET");
    expect(readMediaBufferMock).not.toHaveBeenCalled();
  });

  it("serves HEAD without body bytes", async () => {
    readMediaBufferMock.mockResolvedValueOnce({
      id: "abc.png",
      path: "/fake/abc.png",
      buffer: png,
      size: png.byteLength,
    });

    const res = await callEndpoint({
      pathName: "/api/media/agent-output/abc.png",
      method: "HEAD",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-length"]).toBe(String(png.byteLength));
    expect(res.body.byteLength).toBe(0);
  });
});
