/**
 * Launcher 子选择页：模型 picker + 服务商 picker
 *
 * 抽出来是为了让 LauncherView 保持在 600 行以内（CLAUDE.md 硬规则）。
 * 两个 picker 的键盘逻辑仍在 LauncherView 里，这里只负责渲染。
 */
import React from "react";
import { Box, Text } from "ink";
import type { LaunchOption } from "../../../clients";
import type { Provider } from "../../../providers/types";
import {
  MODEL_PAGE_SIZE,
  modelPickerWindow,
  resolveModelPickerEntries,
} from "../../shared/model-picker";

const GROUP_PICKER_FOOTER_HINTS = [
  ["↑↓", "选择", "select"],
  ["Enter", "确认", "confirm"],
  ["Esc", "取消", "cancel"],
] as const;

const PROVIDER_PICKER_FOOTER_HINTS = [
  ["↑↓", "选择", "select"],
  ["Enter", "切换", "switch"],
  ["k", "改Key", "edit key"],
  ["m", "管理", "manage"],
  ["Esc", "取消", "cancel"],
] as const;

function HintFooter({
  hints,
  zh,
}: {
  hints: ReadonlyArray<readonly [string, string, string]>;
  zh: boolean;
}) {
  return (
    <Box marginTop={0} justifyContent="center" gap={2}>
      {hints.flatMap((h, i) => {
        const sep = i > 0 ? <Text key={`s${i}`} dimColor>│</Text> : null;
        return [
          sep,
          <Text key={`k${i}`} dimColor bold>{h[0]}</Text>,
          <Text key={`l${i}`} dimColor>{zh ? h[1] : h[2]}</Text>,
        ];
      })}
    </Box>
  );
}

// ─── 服务商 picker ──────────────────────────────────────────

export function ProviderPicker({
  provs, provIdx, pickerIdx, color, zh,
}: {
  provs: Provider[]; provIdx: number; pickerIdx: number; color: string; zh: boolean;
}) {
  return (
    <Box flexDirection="column" marginTop={0} borderStyle="round" borderColor={color} paddingX={1} paddingY={0}>
      <Text bold color={color}>▣ {zh ? "选择服务商" : "Pick Provider"}</Text>
      <Box flexDirection="column" marginTop={0}>
        {provs.length === 0 && (
          <Box paddingLeft={1}>
            <Text dimColor>{zh ? "暂无兼容此工具的服务商" : "No compatible providers"}</Text>
          </Box>
        )}
        {provs.map((p, i) => {
          const focused = pickerIdx === i;
          const isCur = i === provIdx;
          return (
            <Box key={p.id} paddingLeft={1}>
              <Text color={focused ? color : undefined} bold={focused}>
                {focused ? "▸" : " "}
              </Text>
              <Text bold={focused} color={focused ? color : undefined}>
                {" "}{p.name}
              </Text>
              {p.email && <Text dimColor>  ({p.email})</Text>}
              {isCur && <Text color="green"> ★</Text>}
            </Box>
          );
        })}
        {/* 管理服务商入口 */}
        {(() => {
          const focused = pickerIdx === provs.length;
          return (
            <Box paddingLeft={1} marginTop={1}>
              <Text color={focused ? color : undefined} bold={focused}>
                {focused ? "▸" : " "}
              </Text>
              <Text bold={focused} color={focused ? color : undefined}>
                {" "}⚙  {zh ? "管理服务商…" : "Manage providers…"}
              </Text>
            </Box>
          );
        })()}
      </Box>
      <HintFooter hints={PROVIDER_PICKER_FOOTER_HINTS} zh={zh} />
    </Box>
  );
}

// ─── 模型 group picker ──────────────────────────────────────

export function GroupPicker({
  group, options, enabled, pickerIdx, color, zh, pickCounts = {}, query = "",
}: {
  group: string;
  options: LaunchOption[];
  enabled: Set<string>;
  pickerIdx: number;
  color: string;
  zh: boolean;
  pickCounts?: Record<string, number>;
  query?: string;
}) {
  const groupOpts = options.filter((o) => o.group === group);
  const isModelGroup = group === "model";
  const modelEntries = isModelGroup
    ? resolveModelPickerEntries(groupOpts, pickCounts, query, zh)
    : [];
  const window = isModelGroup
    ? modelPickerWindow(pickerIdx, modelEntries.length)
    : { start: 0, end: groupOpts.length };
  const title = isModelGroup
    ? (zh ? "选择模型" : "Pick Model")
    : group === "subagent-model"
      ? (zh ? "子代理模型" : "Subagent Model")
      : group;
  const isDefaultCur = !groupOpts.some((o) => enabled.has(o.id));

  return (
    <Box flexDirection="column" marginTop={0} borderStyle="round" borderColor={color} paddingX={1} paddingY={0}>
      <Text bold color={color}>▣ {title}</Text>
      {isModelGroup && (
        <Box paddingLeft={1}>
          <Text color={color} bold>› </Text>
          <Text bold={!!query} dimColor={!query}>
            {query || (zh ? "输入字母筛选" : "Type to filter")}
          </Text>
          <Text inverse> </Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={0}>
        {isModelGroup ? (
          <>
            {modelEntries.slice(window.start, window.end).map((entry, i) => {
              const idx = window.start + i;
              const focused = pickerIdx === idx;
              if (entry.kind === "default" || !entry.option) {
                return (
                  <Box key="__default__" paddingLeft={1}>
                    <Text color={focused ? color : undefined} bold={focused}>
                      {focused ? "▸" : " "}
                    </Text>
                    <Text bold={focused} color={focused ? color : undefined}>
                      {" "}{zh ? "默认（跟随客户端，不传 --model）" : "Default (client built-in, no --model)"}
                    </Text>
                    {isDefaultCur && <Text color="green"> ★</Text>}
                  </Box>
                );
              }
              const opt = entry.option;
              const isCur = enabled.has(opt.id);
              return (
                <Box key={opt.id} paddingLeft={1} flexDirection="column">
                  <Box>
                    <Text color={focused ? color : undefined} bold={focused}>
                      {focused ? "▸" : " "}
                    </Text>
                    <Text bold={focused} color={focused ? color : undefined}>
                      {" "}{opt.label[zh ? "zh" : "en"] || opt.label.en}
                    </Text>
                    {isCur && <Text color="green"> ★</Text>}
                    <Text dimColor>  {opt.flag}</Text>
                  </Box>
                  {focused && (
                    <Box paddingLeft={3}>
                      <Text dimColor>{opt.description[zh ? "zh" : "en"] || opt.description.en}</Text>
                    </Box>
                  )}
                </Box>
              );
            })}
            {modelEntries.length === 0 && (
              <Box paddingLeft={1}>
                <Text dimColor>{zh ? "无匹配模型" : "No matching models"}</Text>
              </Box>
            )}
            {modelEntries.length > MODEL_PAGE_SIZE && (
              <Box paddingLeft={1}>
                <Text dimColor>{pickerIdx + 1}/{modelEntries.length}</Text>
              </Box>
            )}
          </>
        ) : (
          <>
            {(() => {
              const focused = pickerIdx === 0;
              return (
                <Box paddingLeft={1}>
                  <Text color={focused ? color : undefined} bold={focused}>
                    {focused ? "▸" : " "}
                  </Text>
                  <Text bold={focused} color={focused ? color : undefined}>
                    {" "}{zh ? "默认（不指定）" : "Default (none)"}
                  </Text>
                  {isDefaultCur && <Text color="green"> ★</Text>}
                </Box>
              );
            })()}
            {groupOpts.map((opt, idx) => {
              const focused = pickerIdx === idx + 1;
              const isCur = enabled.has(opt.id);
              return (
                <Box key={opt.id} paddingLeft={1} flexDirection="column">
                  <Box>
                    <Text color={focused ? color : undefined} bold={focused}>
                      {focused ? "▸" : " "}
                    </Text>
                    <Text bold={focused} color={focused ? color : undefined}>
                      {" "}{opt.label[zh ? "zh" : "en"] || opt.label.en}
                    </Text>
                    {isCur && <Text color="green"> ★</Text>}
                    <Text dimColor>  {opt.flag}</Text>
                  </Box>
                  {focused && (
                    <Box paddingLeft={3}>
                      <Text dimColor>{opt.description[zh ? "zh" : "en"] || opt.description.en}</Text>
                    </Box>
                  )}
                </Box>
              );
            })}
          </>
        )}
      </Box>
      <HintFooter hints={GROUP_PICKER_FOOTER_HINTS} zh={zh} />
    </Box>
  );
}
