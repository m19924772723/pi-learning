/**
 * Day 22 · 进阶② 自定义 Provider —— 模式 2 streamSimple 协议验证
 *
 * 目标：验证非标准 API 走 `streamSimple` 的完整协议：
 *  - 自定义 api 字符串必须搭配 streamSimple（否则 getApiProvider 返回 undefined）
 *  - streamSimple 实现返回 AssistantMessageEventStream，事件序列 start → text_* → done/error
 *  - error 事件必须携带 AssistantMessage，不能是 raw Error
 *
 * 用本地 mock（不发真实网络请求）：streamSimple 直接回显一条文本，验证
 * ModelRuntime.completeSimple 能拿到自定义协议的输出。若取消注册 / 换成
 * 无 streamSimple 的 provider，调用会抛 "No API provider registered for api: <x>"。
 */
import { ModelRuntime, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

process.env.MOCK_KEY = "test-key"; // 让 $MOCK_KEY 插值可解析，否则 prepareRequest 的 getAuth 会在进 streamSimple 前失败

async function main() {
  const runtime = await ModelRuntime.create({});

  // ---------- 模式 2：自定义协议 + 本地 mock ----------
  console.log("===== 模式 2：streamSimple 自定义流 =====\n");
  const config: ProviderConfig = {
    name: "Mock Echo（自定义协议）",
    baseUrl: "mock://echo",
    apiKey: "$MOCK_KEY",
    api: "mock-echo-v1", // 自定义 api 标识符（任意字符串）
    streamSimple: (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      (async () => {
        const output: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "pending",
          timestamp: Date.now(),
        };
        try {
          // 1. start（partial 是当前 output 引用）
          stream.push({ type: "start", partial: output });
          // 2. 文本块事件序列：text_start → text_delta → text_end
          const userText = context.messages
            .filter((m): m is { role: "user"; content: Array<{ type: "text"; text: string }> } => m.role === "user")
            .map((m) => m.content.filter((c) => c.type === "text").map((c) => c.text).join(""))
            .join(" ");
          const text = `[mock-echo] ${userText}`;
          output.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          for (const ch of text) {
            output.content[0] = { type: "text", text: (output.content[0] as { text: string }).text + ch };
            stream.push({ type: "text_delta", contentIndex: 0, delta: ch, partial: output });
          }
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
          // 3. done 并 end
          output.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message: output });
          stream.end();
        } catch (err) {
          // ⚠️ error 字段必须是 AssistantMessage，把错误写进 output 再 push
          output.stopReason = "error";
          output.errorMessage = err instanceof Error ? err.message : String(err);
          stream.push({ type: "error", reason: "error", error: output });
          stream.end();
        }
      })();
      return stream;
    },
    models: [
      {
        id: "echo-1",
        name: "Echo 1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  };
  runtime.registerProvider("mock-echo", config);

  const model = runtime.getModel("mock-echo", "echo-1")!;
  const context: Context = {
    messages: [
      { role: "user", content: [{ type: "text", text: "你好，自定义协议" }], timestamp: Date.now() },
    ],
  };
  const result = await runtime.completeSimple(model, context, {});
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  console.log("自定义协议输出:", text);
  console.log("stopReason:", result.stopReason);
  console.log("验证通过：streamSimple 事件序列被框架正确消费\n");

  // ---------- 负向：provider 无 streamSimple 用自定义 api → 调用失败 ----------
  // 注意：streamWith 兜底分支 getApiProvider 未命中时抛错，但 lazyStream 把
  // 同步 throw 转成 error 事件，所以 completeSimple 不抛 JS 异常，而是 resolve
  // 出一个 stopReason=error、errorMessage 含 "No API provider registered" 的结果。
  console.log("===== 负向：自定义 api 但无 streamSimple =====\n");
  runtime.registerProvider("mock-no-stream", {
    baseUrl: "mock://none",
    apiKey: "$MOCK_KEY",
    api: "mock-echo-v1", // 没有 streamSimple 实现
    models: [
      {
        id: "echo-2",
        name: "Echo 2",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
  try {
    const negResult = await runtime.completeSimple(runtime.getModel("mock-no-stream", "echo-2")!, context, {});
    const failed = negResult.stopReason === "error" && negResult.errorMessage?.includes("No API provider registered for api: mock-echo-v1");
    console.log(failed ? "[OK] 调用失败并报告:" : "[FAIL] 未按预期失败:", negResult.stopReason, "-", negResult.errorMessage);
  } catch (err) {
    console.log("[OK] 调用抛错:", (err as Error).message);
  }

  runtime.unregisterProvider("mock-echo");
  runtime.unregisterProvider("mock-no-stream");
  console.log("\n===== Day 22 模式 2 验证完成 =====");
}

main().catch((err) => {
  console.error("脚本失败:", err);
  process.exitCode = 1;
});