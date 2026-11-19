export const TAKO_DEFAULT_IMAGE_MODEL = "gpt-image-2" as const;
export const TAKO_DEFAULT_VIDEO_MODEL = "grok-imagine-video-1.5" as const;
export const TAKO_DEFAULT_AUDIO_MODEL = "mimo-v2.5-tts" as const;
export const TAKO_DEFAULT_CONSULT_MODEL = "gpt-6.2-sol" as const;

export const TAKO_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
] as const;

export const TAKO_IMAGE_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "1792x1024",
  "1024x1792",
  "auto",
] as const;

export const TAKO_VIDEO_ASPECT_RATIOS = [
  "16:9",
  "3:2",
  "4:3",
  "1:1",
  "3:4",
  "2:3",
  "9:16",
] as const;

export const TAKO_AUDIO_FORMATS = ["wav", "mp3", "pcm"] as const;
export const TAKO_SEARCH_PROVIDERS = ["deepseek", "groq", "grok", "grok_x"] as const;

export const TAKO_MCP_INITIALIZE_INSTRUCTIONS =
  "Prefer Tako MCP tools whenever the user asks for image generation/editing (tako_generate_image, default gpt-image-2), video generation (tako_generate_video, grok-imagine-video-1.5), speech synthesis (tako_generate_audio, default mimo-v2.5-tts), live web search (tako_web_search), a second-model opinion (tako_consult), or Tako balance/quota checks (tako_account_status). Follow tako-skill guardrails: preserve the user's explicit model choice; NEVER auto-retry paid image or video calls on timeout/error (check tako_account_status first, and pass resume_task_id for video recovery); cite actual results[].url on web search without fabricating URLs; never delegate image tasks to built-in `image-generator` subagents when Tako MCP is mounted.";

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  annotations?: McpToolAnnotations;
  inputSchema: Record<string, unknown>;
}

export type McpContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContentItem[];
  isError?: boolean;
}

export interface McpToolDeps {
  fetch?: typeof fetch;
  cwd?: string;
  env?: Record<string, string | undefined>;
  takoHome?: string;
  now?: () => Date;
  pollIntervalMs?: number;
}

export interface TakoMcpCredentials {
  baseUrl: string;
  apiKey: string;
}

export const TAKO_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "tako_generate_image",
    description:
      "Generate or edit an image via Tako (default: gpt-image-2, supporting GPT/Grok/WAN via /v1/images/* and Gemini native via /v1beta/models/*:generateContent) and save it to local disk. Single or multi-reference editing is supported (Grok supports up to 3 references). Paid API: NEVER auto-retry on timeout or failure.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: {
          type: "string",
          description: "Detailed prompt describing the image to generate or edit.",
        },
        model: {
          type: "string",
          description:
            `Image model ID (default: ${TAKO_DEFAULT_IMAGE_MODEL}). Common options: gpt-image-2, gpt-image-2.5-flare, gpt-image-2.5-sunburst, gemini-3.1-flash-image, gemini-3-pro-image, grok-imagine-image-quality, wan2.7-image, wan2.7-image-pro.`,
        },
        size: {
          type: "string",
          enum: [...TAKO_IMAGE_SIZES],
          description:
            "Output size for OpenAI/Grok/WAN image models (or mapped to Gemini aspectRatio when aspect_ratio is omitted).",
        },
        aspect_ratio: {
          type: "string",
          enum: [...TAKO_IMAGE_ASPECT_RATIOS],
          description:
            "Target aspect ratio (mapped to Gemini aspectRatio or OpenAI size when size is omitted).",
        },
        input_image_path: {
          type: "string",
          description: "Optional single local reference image path for image editing.",
        },
        input_image_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional multiple local reference image paths for multi-reference editing (Grok supports up to 3 references).",
        },
        output_path: {
          type: "string",
          description:
            "Optional local file path where the generated image will be saved (defaults to <cwd>/tako-image-<YYYYMMDD-HHMMSS>.<ext>).",
        },
      },
    },
  },
  {
    name: "tako_generate_video",
    description:
      "Generate a video via Tako POST /v1/videos/generations (async 3-step: JSON submit -> poll -> download verified MP4 to local disk, per tako-skill). grok-imagine-video-1.5 is the only video model (legacy grok-imagine-video maps to it). Per-second billing: NEVER auto-resubmit on timeout or failure; pass resume_task_id to recover an existing job.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: [],
      properties: {
        prompt: {
          type: "string",
          description: "Video prompt (required unless resume_task_id is provided).",
        },
        model: {
          type: "string",
          enum: ["grok-imagine-video-1.5", "grok-imagine-video"],
          description:
            `Default: ${TAKO_DEFAULT_VIDEO_MODEL} (legacy grok-imagine-video maps to grok-imagine-video-1.5).`,
        },
        duration: {
          type: "integer",
          minimum: 1,
          maximum: 15,
          description: "Duration in seconds (integer 1-15, default: 5).",
        },
        resolution: {
          type: "string",
          enum: ["480p", "720p", "1080p"],
          description: "Default: 480p (per tako-skill recommendation; also supports 720p and 1080p).",
        },
        aspect_ratio: {
          type: "string",
          enum: [...TAKO_VIDEO_ASPECT_RATIOS],
          description: "Optional target video aspect ratio.",
        },
        input_reference_path: {
          type: "string",
          description: "Optional local image path, public URL, or data URI for image-to-video.",
        },
        resume_task_id: {
          type: "string",
          description: "Existing video task ID to resume polling and download without creating a new paid job.",
        },
        wait_timeout_secs: {
          type: "integer",
          minimum: 5,
          maximum: 300,
          description: "Max seconds to poll before returning task_id (5-300, default: 120).",
        },
        output_path: {
          type: "string",
          description: "Optional local MP4 output path (defaults to <cwd>/tako-video-<YYYYMMDD-HHMMSS>.mp4).",
        },
      },
    },
  },
  {
    name: "tako_generate_audio",
    description:
      "Synthesize speech via Tako POST /v1/audio/speech and save the audio file to local disk. Supports mimo-v2.5-tts (default), speech_tts, mimo-v2.5-tts-voicedesign (style-guided design without voice), and mimo-v2.5-tts-voiceclone (with voice_sample_path).",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: [],
      properties: {
        input: {
          type: "string",
          description: "Text content to synthesize into speech (optional only for mimo-v2.5-tts-voicedesign with instructions).",
        },
        model: {
          type: "string",
          description:
            `TTS model: ${TAKO_DEFAULT_AUDIO_MODEL} (default), speech_tts, mimo-v2.5-tts-voicedesign, or mimo-v2.5-tts-voiceclone.`,
        },
        voice: {
          type: "string",
          description:
            "Preset voice name (mimo_default, 冰糖, 茉莉, 苏打, 白桦, Mia, Chloe, Milo, Dean; default 冰糖). Do NOT send for voicedesign.",
        },
        instructions: {
          type: "string",
          description: "Optional speaking style or voice design description.",
        },
        voice_sample_path: {
          type: "string",
          description: "Local audio sample file path (<=10MB) for mimo-v2.5-tts-voiceclone.",
        },
        response_format: {
          type: "string",
          enum: [...TAKO_AUDIO_FORMATS],
          description: "Output format: wav (default), mp3, or pcm. (opus is unsupported by Tako Speech API.)",
        },
        output_path: {
          type: "string",
          description: "Optional local audio file path (defaults to <cwd>/tako-audio-<YYYYMMDD-HHMMSS>.<ext>).",
        },
      },
    },
  },
  {
    name: "tako_web_search",
    description:
      "Search the live web via Tako POST /v1/search and return answer summary + ranked results. Always cite actual results[].url from the response and never fabricate URLs when results is empty.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Search query string.",
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Number of results to return (1-20, default: 5).",
        },
        provider: {
          type: "string",
          enum: [...TAKO_SEARCH_PROVIDERS],
          description: "Optional search provider family (deepseek, groq, grok, grok_x); omit for automatic routing.",
        },
      },
    },
  },
  {
    name: "tako_consult",
    description:
      "Consult another frontier model via Tako POST /v1/chat/completions for a second opinion, architecture critique, or verification (e.g. gpt-6.2-sol, claude-opus-5-5, deepseek-v4-pro, gemini-3.8-flash).",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        question: {
          type: "string",
          description: "Question or decision prompt to consult on.",
        },
        context: {
          type: "string",
          description: "Optional relevant code, logs, or constraints context.",
        },
        model: {
          type: "string",
          description: `Model ID (default: ${TAKO_DEFAULT_CONSULT_MODEL}, e.g. gpt-6.2-sol, claude-opus-5-5, deepseek-v4-pro, gemini-3.8-flash).`,
        },
        system_prompt: {
          type: "string",
          description: "Optional advisor system instruction.",
        },
      },
    },
  },
  {
    name: "tako_account_status",
    description:
      "Query the current Tako account balance (USD remaining and used), plan/subscription quota (if any), and gateway status in real time.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: [],
      properties: {},
    },
  },
];
