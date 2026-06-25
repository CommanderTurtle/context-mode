/**
 * Issue #4 repro — AgentOutput.usage capture.
 *
 * SDK AgentOutput at sdk-tools.d.ts:64-75 exposes:
 *   - totalTokens                              (L65)
 *   - totalDurationMs                          (L64)
 *   - usage.input_tokens                       (L67)
 *   - usage.output_tokens                      (L68)
 *   - usage.cache_creation_input_tokens        (L69)
 *   - usage.cache_read_input_tokens            (L70)
 *   - usage.service_tier                       (L75)
 *
 * tool_name = "Task" (the sub-agent dispatcher). When tool_response
 * carries a JSON-stringified AgentOutput with a `usage` block, we emit
 * one `agent_usage` event (category: "cost") with structured data
 * encoding the 7 fields as key:value tokens.
 *
 * The platform side persists these as typed columns post-release; the
 * forward-compatible Zod envelope accepts them today (no migration).
 */

import { describe, test, expect, vi } from "vitest";
import { extractEvents } from "../../src/session/extract.js";

function agentUsageOf(toolResponse: unknown, toolName: string = "Task") {
  return extractEvents({
    tool_name: toolName,
    tool_input: { description: "test" },
    tool_response: typeof toolResponse === "string"
      ? toolResponse
      : JSON.stringify(toolResponse),
  }).filter((e) => e.type === "agent_usage");
}

describe("extractAgentUsage — Issue #4 AgentOutput.usage capture", () => {
  test("tracer: full AgentOutput emits one agent_usage event", () => {
    const events = agentUsageOf({
      totalTokens: 1500,
      totalDurationMs: 4200,
      usage: {
        input_tokens: 800,
        output_tokens: 700,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 200,
        service_tier: "standard",
      },
    });
    expect(events.length).toBe(1);
    expect(events[0].category).toBe("cost");
  });

  test("all 7 fields appear in event.data as key:value tokens", () => {
    const events = agentUsageOf({
      totalTokens: 1500,
      totalDurationMs: 4200,
      usage: {
        input_tokens: 800,
        output_tokens: 700,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 200,
        service_tier: "standard",
      },
    });
    const data = events[0].data;
    expect(data).toMatch(/totalTokens:1500/);
    expect(data).toMatch(/totalDurMs:4200/);
    expect(data).toMatch(/tokens_in:800/);
    expect(data).toMatch(/tokens_out:700/);
    expect(data).toMatch(/cache_create:50/);
    expect(data).toMatch(/cache_read:200/);
    expect(data).toMatch(/tier:standard/);
  });

  test("partial usage block — missing fields skipped, present fields captured", () => {
    const events = agentUsageOf({
      totalTokens: 100,
      usage: {
        input_tokens: 60,
        output_tokens: 40,
      },
    });
    expect(events.length).toBe(1);
    expect(events[0].data).toMatch(/tokens_in:60/);
    expect(events[0].data).toMatch(/tokens_out:40/);
    expect(events[0].data).not.toMatch(/cache_create:/);
    expect(events[0].data).not.toMatch(/tier:/);
  });

  test("non-Task tools do NOT emit agent_usage", () => {
    const events = agentUsageOf(
      { totalTokens: 100, usage: { input_tokens: 1, output_tokens: 1 } },
      "Bash",
    );
    expect(events.length).toBe(0);
  });

  test("Task tool with non-JSON response emits no event (graceful)", () => {
    const events = agentUsageOf("plain text result not JSON");
    expect(events.length).toBe(0);
  });

  test("Task tool with JSON but no usage block emits no event", () => {
    const events = agentUsageOf({ result: "ok" });
    expect(events.length).toBe(0);
  });

  test("Task tool with empty usage object still emits if totalTokens present", () => {
    const events = agentUsageOf({ totalTokens: 50, usage: {} });
    expect(events.length).toBe(1);
    expect(events[0].data).toMatch(/totalTokens:50/);
  });

  test("event priority is 2 (cost is high-signal but not blocker)", () => {
    const events = agentUsageOf({
      totalTokens: 100,
      usage: { input_tokens: 50, output_tokens: 50 },
    });
    expect(events[0].priority).toBe(2);
  });

  test("service_tier longer than 32 chars is truncated", () => {
    const events = agentUsageOf({
      totalTokens: 100,
      usage: {
        input_tokens: 1, output_tokens: 1,
        service_tier: "X".repeat(200),
      },
    });
    expect(events.length).toBe(1);
    expect(events[0].data.length).toBeLessThan(400);
  });

  test("regression: extractTask (TodoWrite/TaskCreate/TaskUpdate) still works", () => {
    const events = extractEvents({
      tool_name: "TodoWrite",
      tool_input: { todos: [{ content: "x" }] },
      tool_response: "",
    });
    expect(events.some((e) => e.type === "task")).toBe(true);
    expect(events.filter((e) => e.type === "agent_usage").length).toBe(0);
  });

  // Gap #1 (16-oss-verify-gap-prd §2) — cost_usd derivation
  test("cost_usd: Sonnet pricing 1000 input + 500 output → 0.0105", () => {
    const events = extractEvents({
      tool_name: "Task",
      tool_input: { model: "claude-sonnet-4-6" },
      tool_response: JSON.stringify({
        totalTokens: 1500,
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    }).filter((e) => e.type === "agent_usage");
    expect(events.length).toBe(1);
    expect(events[0].data).toMatch(/cost_usd:0\.0105/);
  });

  test("cost_usd: Opus 4.7 pricing higher than Sonnet 4.6 for same tokens", () => {
    const opus = extractEvents({
      tool_name: "Task",
      tool_input: { model: "claude-opus-4-7" },
      tool_response: JSON.stringify({
        totalTokens: 1500,
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    }).filter((e) => e.type === "agent_usage");
    const sonnet = extractEvents({
      tool_name: "Task",
      tool_input: { model: "claude-sonnet-4-6" },
      tool_response: JSON.stringify({
        totalTokens: 1500,
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    }).filter((e) => e.type === "agent_usage");
    const opusCost = Number(opus[0].data.match(/cost_usd:(\d+\.\d+)/)![1]);
    const sonnetCost = Number(sonnet[0].data.match(/cost_usd:(\d+\.\d+)/)![1]);
    // Opus 4.7 is $5/$25 vs Sonnet 4.6 $3/$15 — Opus runs ~1.67x Sonnet
    expect(opusCost).toBeGreaterThan(sonnetCost);
    expect(opusCost).toBeCloseTo(0.0175, 4);
  });

  test("cost_usd: Haiku pricing lower than Sonnet", () => {
    const haiku = extractEvents({
      tool_name: "Task",
      tool_input: { model: "claude-haiku-4-5" },
      tool_response: JSON.stringify({
        totalTokens: 1500,
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    }).filter((e) => e.type === "agent_usage");
    const haikuCost = Number(haiku[0].data.match(/cost_usd:(\d+\.\d+)/)![1]);
    expect(haikuCost).toBeLessThan(0.01);
  });

  test("cost_usd: cache_creation + cache_read priced separately", () => {
    const events = extractEvents({
      tool_name: "Task",
      tool_input: { model: "claude-sonnet-4-6" },
      tool_response: JSON.stringify({
        totalTokens: 4000,
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 1500,
        },
      }),
    }).filter((e) => e.type === "agent_usage");
    expect(events.length).toBe(1);
    // Expected: 1000*3 + 500*15 + 1000*3.75 + 1500*0.30 = 3000+7500+3750+450 = 14700
    // 14700 / 1_000_000 = 0.0147
    expect(events[0].data).toMatch(/cost_usd:0\.0147/);
  });

  test("cost_usd: unknown model → no cost emitted (was: wrong Claude fallback)", () => {
    // Catalog rewire — an unmatched model id no longer inherits Claude-Sonnet's
    // rate (the old `default` bug). It resolves to null cost, so the event is
    // still emitted (token counts) but carries NO cost_usd token. The catalog
    // also console.warns the unmatched id once; silence it here.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = extractEvents({
      tool_name: "Task",
      tool_input: { model: "claude-future-model-99" },
      tool_response: JSON.stringify({
        totalTokens: 1500,
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    }).filter((e) => e.type === "agent_usage");
    warn.mockRestore();
    expect(events.length).toBe(1);
    expect(events[0].data).not.toMatch(/cost_usd:/);
  });

  test("cost_usd: Opus 4.8 priced at same standard rate as Opus 4.7", () => {
    const opus48 = extractEvents({
      tool_name: "Task",
      tool_input: { model: "claude-opus-4-8" },
      tool_response: JSON.stringify({
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    }).filter((e) => e.type === "agent_usage");
    const opus47 = extractEvents({
      tool_name: "Task",
      tool_input: { model: "claude-opus-4-7" },
      tool_response: JSON.stringify({
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    }).filter((e) => e.type === "agent_usage");
    const c48 = opus48[0].data.match(/cost_usd:(\d+\.\d+)/)![1];
    const c47 = opus47[0].data.match(/cost_usd:(\d+\.\d+)/)![1];
    expect(c48).toBe(c47);
  });

  test("cost_usd: date-suffixed model id (haiku-4-5-20251001) resolves via prefix", () => {
    const events = extractEvents({
      tool_name: "Task",
      tool_input: { model: "claude-haiku-4-5-20251001" },
      tool_response: JSON.stringify({
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    }).filter((e) => e.type === "agent_usage");
    // Haiku rate: 1000*1 + 500*5 = 3500 / 1_000_000 = 0.0035
    expect(events[0].data).toMatch(/cost_usd:0\.0035/);
  });

  test("cost_usd: no model id → no cost emitted (cannot price without a model)", () => {
    // Catalog rewire — without a model id there is no row to price from, so no
    // cost_usd is blended. The empty id is not warned (it is not a real miss).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = extractEvents({
      tool_name: "Task",
      tool_input: {},
      tool_response: JSON.stringify({
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    }).filter((e) => e.type === "agent_usage");
    warn.mockRestore();
    expect(events.length).toBe(1);
    expect(events[0].data).not.toMatch(/cost_usd:/);
  });

  test("cost_usd: zero tokens → cost_usd:0 not emitted (skip)", () => {
    const events = extractEvents({
      tool_name: "Task",
      tool_input: { model: "claude-sonnet-4-6" },
      tool_response: JSON.stringify({
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    }).filter((e) => e.type === "agent_usage");
    // Either no event OR an event without cost_usd
    if (events.length > 0) {
      expect(events[0].data).not.toMatch(/cost_usd:/);
    }
  });
});

/**
 * Wave 2b — structured cost event.
 *
 * The colon-string `data` is opaque to the platform (it cannot column-ize a
 * "tokens_in:123 cost_usd:0.02" blob). extractAgentUsage now also emits the
 * cost/token signals as top-level SessionEvent fields, which the forward
 * envelope spreads straight to the platform as typed columns:
 *
 *   model_id, input_tokens, output_tokens,
 *   cache_read_tokens, cache_creation_tokens, cost_usd
 *
 * The colon-string `data` stays for human/debug + back-compat.
 */
describe("extractAgentUsage — Wave 2b structured cost fields", () => {
  function usageEvent(toolInput: Record<string, unknown>, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return extractEvents({
      tool_name: "Task",
      tool_input: toolInput,
      tool_response: JSON.stringify({ ...extra, usage }),
    }).filter((e) => e.type === "agent_usage")[0];
  }

  // (a) the 6 structured fields ride the event with correct values
  test("(a) Task usage yields event carrying the 6 structured fields with correct values", () => {
    const ev = usageEvent(
      { model: "claude-sonnet-4-6" },
      {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 1500,
      },
    );
    expect(ev.model_id).toBe("claude-sonnet-4-6");
    expect(ev.input_tokens).toBe(1000);
    expect(ev.output_tokens).toBe(500);
    expect(ev.cache_creation_tokens).toBe(1000);
    expect(ev.cache_read_tokens).toBe(1500);
    // 1000*3 + 500*15 + 1000*3.75 + 1500*0.30 = 14700 / 1e6 = 0.0147
    expect(ev.cost_usd).toBeCloseTo(0.0147, 8);
  });

  // (b) cost_usd matches the catalog for a known model
  test("(b) cost_usd matches the catalog for a known model (gpt-5)", () => {
    const ev = usageEvent(
      { model: "gpt-5" },
      { input_tokens: 1000, output_tokens: 500 },
    );
    // gpt-5: 1000*1.25 + 500*10 = 6250 / 1e6 = 0.00625
    expect(ev.cost_usd).toBeCloseTo(0.00625, 8);
    expect(ev.model_id).toBe("gpt-5");
  });

  // (c) unknown model → tokens present, cost_usd omitted (no Claude fallback)
  test("(c) unknown model → tokens present, cost_usd omitted/null", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ev = usageEvent(
      { model: "claude-future-model-99" },
      { input_tokens: 1000, output_tokens: 500 },
    );
    warn.mockRestore();
    expect(ev.input_tokens).toBe(1000);
    expect(ev.output_tokens).toBe(500);
    expect(ev.cost_usd == null).toBe(true);
  });

  // (d) zero-token response → no cost_usd
  test("(d) zero-token response → no cost_usd", () => {
    const ev = usageEvent(
      { model: "claude-sonnet-4-6" },
      { input_tokens: 0, output_tokens: 0 },
    );
    expect(ev.cost_usd == null).toBe(true);
  });

  // (e) the existing colon-string `data` still present for back-compat
  test("(e) colon-string data still present for back-compat", () => {
    const ev = usageEvent(
      { model: "claude-sonnet-4-6" },
      { input_tokens: 1000, output_tokens: 500 },
    );
    expect(ev.data).toMatch(/tokens_in:1000/);
    expect(ev.data).toMatch(/tokens_out:500/);
    expect(ev.data).toMatch(/cost_usd:0\.0105/);
  });
});
