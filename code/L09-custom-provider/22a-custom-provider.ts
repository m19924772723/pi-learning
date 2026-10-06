/**
 * Day 22 · 进阶② 自定义 Provider —— 实测脚本
 *
 * 目标：验证 pi 扩展机制的核心 API `pi.registerProvider()` 的真实行为。
 * 因 `registerProvider` 是 ExtensionAPI 上的方法，本脚本用其实现层
 * `ModelRuntime.registerProvider(providerId, config)`（扩展层重载 2 的最终调用目标）
 * 做等价验证；真实调用走 `completeSimple()`（与 agent loop 相同的流式路径）。
 *
 * 覆盖：
 *  - 模式 1a：openai-completions 兼容网关注册（含 compat 覆盖）
 *  - 真实链路：注册后用 `completeSimple` 对 siyu relay + deepseek-v4-flash 发起一次请求
 *  - 模式 4：覆盖已有 provider 的 baseUrl（不传 models → override-only 分支）
 *  - 校验规则：streamSimple 无 api / models 无 baseUrl / 无认证 三类报错
 *  - unregisterProvider 清理
 */
import { ModelRuntime, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";

function section(title: string) {
  console.log(`\n===== ${title} =====`);
}

async function main() {
  // 用本机 ~/.pi/agent 的 models.json（含 siyu relay 配置）创建 ModelRuntime。
  // allowModelNetwork 默认 false，不会发起目录刷新请求。
  const runtime = await ModelRuntime.create({});
  console.log("ModelRuntime.create OK");
  console.log(
    "内置 provider:",
    runtime.getProviders().map((p) => p.id).join(", "),
  );

  // ---------- 0. 注册前确认不存在 ----------
  section("0. 注册前：siyu-custom 不存在");
  console.log("getProvider('siyu-custom') =", runtime.getProvider("siyu-custom") ?? "undefined（符合预期）");

  // ---------- 模式 1a：注册 OpenAI 兼容网关 ----------
  section("1. 模式 1a：registerProvider('siyu-custom', config)");
  const config: ProviderConfig = {
    name: "Siyu Relay (自定义)",
    baseUrl: "https://siyu.site/v1",
    apiKey: "$HERMES_CUSTOM_SIYU3_API_KEY", // $ENV 插值语法
    api: "openai-completions",
    models: [
      {
        id: "deepseek-v4-flash",
        name: "deepseek-v4-flash",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
        // 非 OpenAI 原生的兼容网关通常需要覆盖默认行为
        compat: {
          supportsDeveloperRole: false,
          supportsStore: false,
          maxTokensField: "max_tokens",
          supportsReasoningEffort: false,
        },
      },
    ],
  };
  runtime.registerProvider("siyu-custom", config);
  const provider = runtime.getProvider("siyu-custom");
  console.log("getProvider('siyu-custom') =", provider?.id, "| name =", provider?.name);
  const models = runtime.getModels("siyu-custom");
  console.log("模型数 =", models.length, "| ids =", models.map((m) => m.id).join(", "));
  console.log("模型 baseUrl =", models[0].baseUrl, "| api =", models[0].api);

  // ---------- 真实链路：completeSimple ----------
  section("2. 真实链路：completeSimple 调用 deepseek-v4-flash");
  const model = models[0];
  const context: Context = {
    systemPrompt: "你是 pi 学习计划第 22 天的测试助手，回答保持简短。",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "请用一句话自我介绍（说明你正在通过自定义 Provider 提供服务）。" }],
        timestamp: Date.now(),
      },
    ],
  };
  try {
    const result = await runtime.completeSimple(model, context, {});
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    console.log("回复:", text);
    console.log("usage:", JSON.stringify(result.usage));
    console.log("stopReason:", result.stopReason);
  } catch (err) {
    console.error("真实调用失败（网络或网关问题）:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }

  // ---------- 模式 4：覆盖已有 provider 的 baseUrl ----------
  section("3. 模式 4：覆盖已有 provider 的 baseUrl（override-only）");
  const siyuBefore = runtime.getModels("siyu");
  console.log("覆盖前 siyu 模型数 =", siyuBefore.length);
  runtime.registerProvider("siyu", {
    baseUrl: "https://siyu.site/v1", // 不传 models → 只改端点，模型保留
  });
  const siyuAfter = runtime.getModels("siyu");
  console.log("覆盖后 siyu 模型数 =", siyuAfter.length, "（模型未被清空，符合 override-only）");
  console.log("baseUrl 生效 =", siyuAfter.every((m) => m.baseUrl === "https://siyu.site/v1"));

  // ---------- 校验规则（负向用例） ----------
  // registerProvider 只同步抛「结构校验」(validateExtensionProvider) 错误：
  // streamSimple 无 api / models 缺 baseUrl / model 缺 api。
  // 「无认证」不在此列：composeApiKeyAuth 始终会合成一个带 login 提示兜底的
  // ApiKeyAuth（交互式工具可在运行时输入 key），所以组合期不报错；认证缺失
  // 延迟到调用期（prepareRequest → getAuth），completeSimple 返回 error 结果
  // 且 getProviderAuthStatus 为 configured:false。
  section("4. 校验规则：三类非法注册的行为");
  // 4a. streamSimple 无 api —— validateExtensionProvider 同步抛错
  try {
    runtime.registerProvider("bad-1", { streamSimple: (() => ({} as never)) as never });
    console.log("[FAIL] bad-1 streamSimple 无 api：未抛错");
  } catch (err) {
    console.log("[OK] bad-1 streamSimple 无 api 抛错:", (err as Error).message);
  }
  // 4b. models 无 baseUrl —— applyExtension 同步抛错
  try {
    runtime.registerProvider("bad-2", {
      api: "openai-completions",
      models: [{ id: "x", name: "x", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    });
    console.log("[FAIL] bad-2 models 无 baseUrl：未抛错");
  } catch (err) {
    console.log("[OK] bad-2 models 无 baseUrl 抛错:", (err as Error).message);
  }
  // 4c. 无认证 —— 注册不抛（login 兜底），调用期才失败
  try {
    runtime.registerProvider("bad-3", {
      api: "openai-completions",
      baseUrl: "https://x.example",
      models: [{ id: "x", name: "x", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    });
    console.log("[OK] bad-3 无认证：registerProvider 未抛错（认证延迟到调用期）");
  } catch (err) {
    console.log("[FAIL] bad-3 无认证注册抛错:", (err as Error).message);
  }
  const bad3model = runtime.getModel("bad-3", "x");
  let bad3call = "无法取到模型";
  if (bad3model) {
    try {
      const r = await runtime.completeSimple(bad3model, { messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] }, {});
      bad3call = `resolve 但 stopReason=${r.stopReason}`;
      if (r.errorMessage) bad3call += `：${r.errorMessage}`;
    } catch (err) {
      bad3call = (err as Error).message;
    }
  }
  const bad3auth = JSON.stringify(runtime.getProviderAuthStatus("bad-3"));
  const bad3ok = bad3call.includes("Provider is not configured: bad-3");
  console.log(`[${bad3ok ? "OK" : "FAIL"}] 无认证调用期报错 = ${bad3ok}: ${bad3call}`);
  console.log("     getProviderAuthStatus('bad-3') =", bad3auth);
  runtime.unregisterProvider("bad-3");

  // ---------- unregisterProvider 清理 ----------
  section("5. unregisterProvider('siyu-custom')");
  runtime.unregisterProvider("siyu-custom");
  console.log("清理后 getProvider('siyu-custom') =", runtime.getProvider("siyu-custom") ?? "undefined（已移除）");

  console.log("\n===== Day 22 实测完成 =====");
}

main().catch((err) => {
  console.error("脚本失败:", err);
  process.exitCode = 1;
});
