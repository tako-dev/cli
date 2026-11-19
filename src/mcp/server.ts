import {
  TAKO_MCP_TOOLS,
  executeTakoGenerateImage,
  executeTakoWebSearch,
  type McpToolDeps,
} from "./tools";

export const MCP_DEFAULT_PROTOCOL_VERSION = "2025-11-25" as const;

export interface McpServerDeps extends McpToolDeps {
  version?: string;
}

export interface RunTakoMcpServerOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  deps?: McpServerDeps;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}

/**
 * 纯函数 JSON-RPC 2.0 MCP 请求处理器：
 * - 通知（无 id）返回 null，不输出任何响应
 * - 未知方法（含 agy 1.5.12 的 server/discover）立即返回 -32601，绝不挂起
 */
export async function handleMcpRequest(
  msg: unknown,
  deps?: McpServerDeps,
): Promise<Record<string, unknown> | null> {
  if (!isPlainObject(msg)) {
    return jsonRpcError(null, -32600, "Invalid Request");
  }

  const hasId = Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== undefined;
  const id = hasId ? msg.id : undefined;
  const method = msg.method;

  if (typeof method !== "string" || !method.trim()) {
    if (!hasId) {
      return null;
    }
    return jsonRpcError(id, -32600, "Invalid Request");
  }

  // Notifications carry no id and MUST NOT receive a response.
  if (!hasId) {
    return null;
  }

  const params = isPlainObject(msg.params) ? msg.params : {};

  switch (method) {
    case "initialize": {
      const clientProtocolVersion =
        typeof params.protocolVersion === "string" && params.protocolVersion.trim()
          ? params.protocolVersion.trim()
          : MCP_DEFAULT_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: clientProtocolVersion,
          capabilities: { tools: {} },
          serverInfo: {
            name: "tako",
            version: deps?.version ?? (process.env.VERSION || "dev"),
          },
        },
      };
    }

    case "ping":
      return {
        jsonrpc: "2.0",
        id,
        result: {},
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TAKO_MCP_TOOLS },
      };

    case "tools/call": {
      const toolName = typeof params.name === "string" ? params.name.trim() : "";
      if (!toolName) {
        return jsonRpcError(id, -32602, "Invalid params: missing tool name");
      }

      const rawArgs = params.arguments;
      if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
        return jsonRpcError(id, -32602, "Invalid params: arguments must be an object");
      }
      const toolArgs = rawArgs ?? {};

      if (toolName === "tako_generate_image") {
        const result = await executeTakoGenerateImage(toolArgs, deps);
        return { jsonrpc: "2.0", id, result };
      }

      if (toolName === "tako_web_search") {
        const result = await executeTakoWebSearch(toolArgs, deps);
        return { jsonrpc: "2.0", id, result };
      }

      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        },
      };
    }

    case "resources/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { resources: [] },
      };

    case "prompts/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { prompts: [] },
      };

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * 启动 stdio JSON-RPC 2.0 MCP Server：
 * - 按换行分帧，兼容 chunk 切分、单 chunk 多行、\r\n、空行与非法 JSON（返回 -32700）
 * - stdout 仅输出单行 JSON + '\n'，严禁使用 console.log
 * - stdin EOF 时等待在途请求完成后优雅退出
 */
export async function runTakoMcpServer(opts?: RunTakoMcpServerOptions): Promise<void> {
  const stdin = opts?.stdin ?? process.stdin;
  const stdout = opts?.stdout ?? process.stdout;
  const deps = opts?.deps;

  const writeResponse = (payload: Record<string, unknown>) => {
    stdout.write(`${JSON.stringify(payload)}\n`);
  };

  let buffer = "";
  let queue: Promise<void> = Promise.resolve();

  const processLine = (rawLine: string) => {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line) return;

    queue = queue
      .then(async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          writeResponse(jsonRpcError(null, -32700, "Parse error"));
          return;
        }

        const response = await handleMcpRequest(parsed, deps);
        if (response !== null) {
          writeResponse(response);
        }
      })
      .catch(() => {
        // Keep the stdio loop alive even if an unexpected error occurs.
      });
  };

  await new Promise<void>((resolveDone) => {
    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        processLine(line);
        newlineIdx = buffer.indexOf("\n");
      }
    };

    const finish = () => {
      if (buffer.trim().length > 0) {
        processLine(buffer);
        buffer = "";
      }
      void queue.finally(() => {
        stdin.off("data", onData);
        stdin.off("end", onEnd);
        stdin.off("error", onError);
        resolveDone();
      });
    };

    const onEnd = () => finish();
    const onError = () => finish();

    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    if (typeof stdin.resume === "function") {
      stdin.resume();
    }
  });
}
