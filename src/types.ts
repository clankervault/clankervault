export type RecordType = 'fact' | 'recipe' | 'decision' | 'taste';
export type RecordStatus = 'unconfirmed' | 'confirmed' | 'superseded';
export type Confidence = 'high' | 'medium' | 'low';

export interface RecordSource {
  tool: string;               // claude-code | codex | mcp:<assistant> | manual tooling later
  transcript?: string;
  approx_range?: string;
}

export interface RecordMeta {
  id: string;                 // e.g. rcp-2026-07-12-a1b2
  type: RecordType;
  date: string;               // YYYY-MM-DD
  status: RecordStatus;
  supersedes: string | null;
  superseded_by: string | null;
  scope: string | null;
  confidence: Confidence;
  source: RecordSource | null; // null = written by hand
  tags: string[];
  /** optional, spec §7: device name → anchored path, or null = not present there */
  availability?: Record<string, string | null> | null;
}

export interface DeviceSyncConfig {
  backend: 'dir';
  path: string;              // where the encrypted remote lives (mounted folder)
  passphrase?: string;       // or env VAULT_PASSPHRASE
}

export interface DeviceConfig {
  device: string;                     // e.g. "macbook"
  anchors: Record<string, string>;    // e.g. { nas: "/Volumes/NAS" }
  projects: Record<string, string>;   // project id → local root path
  sync?: DeviceSyncConfig;
}

export interface VaultRecord {
  meta: RecordMeta;
  title: string;
  body: string;               // body without the leading H1 title
  path: string;
}

export interface ProjectRoot {
  git?: string;               // git remote URL
  path?: string;              // absolute dir prefix on disk
}

export type ProjectKind = 'code' | 'creative';

export interface ProjectInfo {
  id: string;
  name: string;
  aliases: string[];
  kind: ProjectKind;
  roots: ProjectRoot[];
  facts: string;              // body of project.md (identity + facts)
  dir: string;                // absolute path of projects/<id>
}

export interface VaultConfig {
  spec_version: number;
  compile: { token_budget: number };
}

export interface CompiledContext {
  project: ProjectInfo;
  device: DeviceConfig;
  profile: string | null;                    // me/profile.md body
  globalTaste: string[];                     // condensed lines from me/taste/*.md
  records: Record<RecordType, string[]>;     // condensed confirmed lines per type
  unconfirmed: string[];                     // condensed unconfirmed high-confidence lines
  state: string | null;                      // state.md content
  droppedCount: number;                      // lines cut by token budget
}
