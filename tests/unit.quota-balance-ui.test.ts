import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import type { OfficialQuota } from "../src/quota";
import { fg } from "../src/statusline/colors";
import { QuotaSegment } from "../src/statusline/segments/quota";
import { QuotaLine } from "../src/ui/ink/views/LauncherChrome";

function renderInkOnce(element: React.ReactElement): string {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  (stdout as any).columns = 120;
  (stdout as any).rows = 20;
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as any).isTTY = true;
  (stdin as any).setRawMode = () => stdin;
  (stdin as any).ref = () => stdin;
  (stdin as any).unref = () => stdin;
  const app = render(element, { stdout, stdin, debug: true, exitOnCtrlC: false });
  app.unmount();
  return output;
}

describe("Tako wallet balance UI rendering (Statusline & Launcher)", () => {
  it("Statusline QuotaSegment renders wallet balance with green/yellow/red thresholds for pay-as-you-go users", () => {
    const seg = new QuotaSegment() as unknown as { renderTako: (q: OfficialQuota) => string | null };

    const green = seg.renderTako({
      provider: "tako",
      status: "ok",
      balanceUsd: 12.5,
      daily: { usedPct: 0, costUsed: 2.3 },
      fetchedAt: Date.now(),
    });
    expect(green).toContain("余额");
    expect(green).toContain("$12.50");
    expect(green).toContain(fg.brightGreen);
    expect(green).not.toContain("Day:");

    const yellow = seg.renderTako({
      provider: "tako",
      status: "ok",
      balanceUsd: 3.2,
      fetchedAt: Date.now(),
    });
    expect(yellow).toContain("余额");
    expect(yellow).toContain("$3.20");
    expect(yellow).toContain(fg.brightYellow);

    const red = seg.renderTako({
      provider: "tako",
      status: "ok",
      balanceUsd: 0.5,
      fetchedAt: Date.now(),
    });
    expect(red).toContain("余额");
    expect(red).toContain("$0.50");
    expect(red).toContain(fg.brightRed);
  });

  it("Statusline QuotaSegment keeps showing only plan percentages when user has a subscription plan", () => {
    const seg = new QuotaSegment() as unknown as { renderTako: (q: OfficialQuota) => string | null };
    const out = seg.renderTako({
      provider: "tako",
      status: "ok",
      primary: { usedPct: 30, costUsed: 10.8, costLimit: 36, windowMinutes: 300 },
      secondary: { usedPct: 48, costUsed: 192, costLimit: 400 },
      balanceUsd: 50,
      fetchedAt: Date.now(),
    });
    expect(out).toContain("5h 剩");
    expect(out).toContain("70%");
    expect(out).toContain("7d 剩");
    expect(out).toContain("52%");
    expect(out).not.toContain("余额");
  });

  it("Launcher QuotaLine renders wallet balance in zh/en for pay-as-you-go users and plan % for plan users", () => {
    const paygoQuota: OfficialQuota = {
      provider: "tako",
      status: "ok",
      balanceUsd: 12.5,
      daily: { usedPct: 0, costUsed: 2.3 },
      fetchedAt: Date.now(),
    };

    const zhOut = renderInkOnce(React.createElement(QuotaLine, { quota: paygoQuota, zh: true }));
    expect(zhOut).toContain("余额:");
    expect(zhOut).toContain("$12.50");
    expect(zhOut).not.toContain("今日");

    const enOut = renderInkOnce(React.createElement(QuotaLine, { quota: paygoQuota, zh: false }));
    expect(enOut).toContain("Balance:");
    expect(enOut).toContain("$12.50");
    expect(enOut).not.toContain("Today");

    const planQuota: OfficialQuota = {
      provider: "tako",
      status: "ok",
      primary: { usedPct: 25, costUsed: 9, costLimit: 36, windowMinutes: 300 },
      secondary: { usedPct: 40, costUsed: 160, costLimit: 400 },
      balanceUsd: 88,
      fetchedAt: Date.now(),
    };
    const planOut = renderInkOnce(React.createElement(QuotaLine, { quota: planQuota, zh: true }));
    expect(planOut).toContain("5h");
    expect(planOut).toContain("75%");
    expect(planOut).toContain("7d");
    expect(planOut).toContain("60%");
    expect(planOut).not.toContain("余额");
  });
});
