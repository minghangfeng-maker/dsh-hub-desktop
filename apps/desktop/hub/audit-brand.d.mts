/** Types for the branding audit the Hub build runs. */

/** One accepted upstream mention and why it is not a branding defect. */
export interface BrandAuditEntry {
  /** Repository-relative dictionary file the mention lives in. */
  file: string
  /** Substring the offending literal must contain. */
  match: string
  /** `B` real model/provider/service, `C` external link, `D` upstream report. */
  category: 'B' | 'C' | 'D'
  /** Why keeping it is correct for a DSH Hub build. */
  reason: string
  /** Profile row the Hub bundle layer must still disable for this entry to stand. */
  disabledRow?: string
}

/** One string literal a dictionary owns. */
export interface DictionaryValue {
  text: string
  line: number
}

/** One offending string with its location. */
export interface BrandAuditHit {
  file: string
  line: number
  text: string
  category: 'source' | 'metadata'
}

/** Result of the source scan. */
export interface BrandAuditScan {
  violations: BrandAuditHit[]
  report: (BrandAuditHit & { classification: string })[]
}

/** Failure the script reports as a configuration problem rather than a branding one. */
export declare class AuditError extends Error {}

/** Read the allowlist of one checkout. */
export declare function readAllowlist(root: string): BrandAuditEntry[]

/** Collect one dictionary file's copy values. */
export declare function dictionaryValues(text: string): DictionaryValue[]

/** Dictionary files and the shell message table. */
export declare function sourceScanFiles(root: string): string[]

/** Package metadata files the plugin manager renders. */
export declare function metadataFiles(root: string): string[]

/** Rows the Hub bundle layers disable, mapped to the layer that does it. */
export declare function disabledRows(root: string): Map<string, string>

/** Allowlist entries that claim a disabled row the Hub layers no longer disable. */
export declare function allowlistProblems(root: string, entries: readonly BrandAuditEntry[]): string[]

/** Scan dictionary sources for unclassified upstream mentions. */
export declare function scanSources(root: string, entries: readonly BrandAuditEntry[]): BrandAuditScan

/** Client packages the Hub composition loads. */
export declare function composedClientPackages(root: string): Set<string>

/** Scan built client bundles for the upstream product name. */
export declare function scanArtifacts(root: string, directory: string): { violations: string[]; bundles: number }
