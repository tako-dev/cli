/**
 * Claude Code 通过 stdin 传入的数据结构
 */
export interface StatusLineInput {
  model: {
    id: string;
    display_name: string;
  };
  workspace: {
    current_dir: string;
  };
  transcript_path: string;
  context_window?: {
    context_window_size: number;
    current_usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    } | null;
    used_percentage: number | null;
    remaining_percentage: number | null;
  };
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_api_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  output_style?: {
    name: string;
  };
}

/**
 * Segment 接口
 */
export interface Segment {
  id: string;
  render(input: StatusLineInput): Promise<string | null> | string | null;
}
