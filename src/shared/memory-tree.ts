export interface MemoryTreeNode {
  id: number;
  count: number;
  summary: string;
  bytes: number;
  startDate: string;
  endDate: string;
}
export interface MemoryTreeOverview {
  nodes: MemoryTreeNode[];
  prepared: number;
  total: number;
}
export interface MemoryTreeExpansion {
  children: MemoryTreeNode[];
  text?: string;
}
