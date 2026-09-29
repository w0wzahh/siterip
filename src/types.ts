export type NotifyEvent =
  | { type: 'log'; msg: string }
  | { type: 'warn'; msg: string }
  | { type: 'file'; count: number; name: string }
  | { type: 'page'; count: number; name: string }
  | { type: 'phase'; phase: string }
  | { type: 'zip'; msg: string }
  | { type: 'done'; jobId: string; files: number; size: string; tree: FileNode | null }
  | { type: 'error'; msg: string };

export type Notify = (event: NotifyEvent) => void;

export interface FileNode {
  type: 'dir' | 'file';
  name: string;
  path: string;
  size?: number;
  ext?: string;
  children?: FileNode[];
}

export interface AssetMeta {
  /** path on disk where raw bytes are staged */
  stagePath: string;
  contentType: string;
  isPage: boolean;
  size: number;
  /** original request method (GET etc.) */
  method: string;
  /** resource type reported by CDP (document, xhr, stylesheet...) */
  resourceType: string;
}

export interface CrawlOptions {
  maxDepth: number;
  maxPages: number;
  maxAssets: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  concurrency: number;
  includeMedia: boolean;
  injectServiceWorker: boolean;
  pageTimeoutMs: number;
  followSitemaps: boolean;
}

export const DEFAULT_OPTIONS: CrawlOptions = {
  maxDepth: 2,
  maxPages: 150,
  maxAssets: 6000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  concurrency: 3,
  includeMedia: true,
  injectServiceWorker: true,
  pageTimeoutMs: 45_000,
  followSitemaps: true,
};

export interface CrawlResult {
  fileCount: number;
  pageCount: number;
  assetCount: number;
  totalBytes: number;
}
