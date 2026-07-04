export type MemoryKind = "semantic" | "episodic";

export interface MemoryScope { deskmate: string; workspace?: string }

export interface Memory {
  key: string;
  value: string;
  kind: MemoryKind;
  importance: number;   // 1–10
  createdAt: string;    // ISO
  updatedAt: string;    // ISO
}

export interface MemoryInput {
  key: string;
  value: string;
  kind?: MemoryKind;
  importance?: number;
}

export interface MemoryStore {
  list(scope: MemoryScope, opts: { limit: number }): Promise<Memory[]>;
  put(scope: MemoryScope, input: MemoryInput): Promise<Memory>;
  delete(scope: MemoryScope, key: string): Promise<boolean>;
}
