import React from "react";
import { Box, Text, useStdout } from "ink";
import type { LaunchOption } from "../../../clients";
import { getDisplayWidth, padToWidth } from "../../../utils/display-width";
import {
  buildGroupedGrid,
  getGridColumnCountForOptions,
  MODEL_GRID_MIN_COLUMN_WIDTH,
} from "../../shared/model-picker";

function GridFooter({ zh }: { zh: boolean }) {
  return (
    <Box marginTop={0} justifyContent="center" gap={2}>
      <Text dimColor bold>↑↓←→</Text><Text dimColor>{zh ? "选择" : "select"}</Text>
      <Text dimColor>│</Text>
      <Text dimColor bold>Enter</Text><Text dimColor>{zh ? "确认" : "confirm"}</Text>
      <Text dimColor>│</Text>
      <Text dimColor bold>m</Text><Text dimColor>{zh ? "当前目录启动" : "launch cwd"}</Text>
      <Text dimColor>│</Text>
      <Text dimColor bold>Esc</Text><Text dimColor>{zh ? "返回" : "back"}</Text>
    </Box>
  );
}

export function ModelGridPicker({
  options,
  enabled,
  pickerIdx,
  color,
  zh,
}: {
  options: LaunchOption[];
  enabled: Set<string>;
  pickerIdx: number;
  color: string;
  zh: boolean;
}) {
  const { stdout } = useStdout();
  const ids = options.map((opt) => opt.id);
  const byId = new Map(options.map((opt) => [opt.id, opt]));
  const labelOf = (id: string) => byId.get(id)?.label[zh ? "zh" : "en"] || byId.get(id)?.label.en || id;
  const columnCount = getGridColumnCountForOptions(options, stdout.columns || 80, zh);
  const grid = buildGroupedGrid(ids, columnCount);
  const cellWidth = Math.max(
    MODEL_GRID_MIN_COLUMN_WIDTH,
    ...(ids.length > 0 ? ids.map((id) => getDisplayWidth(labelOf(id)) + 3) : [0]),
  );

  return (
    <Box flexDirection="column" marginTop={0} borderStyle="round" borderColor={color} paddingX={1} paddingY={0}>
      <Text bold color={color}>▣ {zh ? "选择模型" : "Pick Model"}</Text>
      <Box flexDirection="column" marginTop={0}>
        {grid.groups.map((group, gi) => (
          <Box key={group.family} flexDirection="column" marginTop={0}>
            {gi > 0 && (
              <Box>
                <Text dimColor>{"╌".repeat(Math.max(8, cellWidth * columnCount))}</Text>
              </Box>
            )}
            {group.rows.map((row, rowIdx) => (
              <Box key={`${group.family}-${rowIdx}`}>
                {row.map((id) => {
                  const idx = grid.flat.indexOf(id);
                  const focused = idx === pickerIdx;
                  const isCur = enabled.has(id);
                  const label = labelOf(id);
                  return (
                    <Box key={id} marginRight={1}>
                      <Text color={focused ? color : undefined} bold={focused}>
                        {focused ? "▸" : " "}
                      </Text>
                      <Text color={focused ? color : undefined} bold={focused}>
                        {padToWidth(label, cellWidth)}
                      </Text>
                      {isCur && <Text color="green">★</Text>}
                    </Box>
                  );
                })}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
      <GridFooter zh={zh} />
    </Box>
  );
}
