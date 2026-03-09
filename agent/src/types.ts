export interface AgentConfig {
  port: number;
  apiKey: string;
  ocServePort: number;
  historyDir: string;
  jwtSecret?: string;
  claudeHistoryDir?: string;    // default: ~/.claude
  source?: "opencode" | "claude-code" | "both";  // default: "opencode"
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface HealthResponse {
  status: 'ok';
  version: string;
  uptime: number;
  ocServeConnected: boolean;
  sseConnected: boolean;
  claudeSourceConnected?: boolean;
}


export interface QueriesResponse {
  queries: Record<string, unknown>[] | import('./oc-query-collector.js').QueryEntry[];
}

export interface TokenRequest {
  apiKey: string;
}

export interface TokenResponse {
  token: string;
  expiresIn: string;
}

export interface CreateSessionBody {
  directory: string;
}

export interface SendMessageBody {
  parts: ReadonlyArray<{ type: string; text: string }>;
}

export interface ReplyToQuestionBody {
  answer: unknown;
}

export interface ReplyToPermissionBody {
  allow: boolean;
}

export interface RunCommandBody {
  command: string;
}
