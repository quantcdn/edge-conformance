// Types for @quantcdn/edge-conformance: the adapter interface, the vector
// case shape and the runner.

/** A request as a vector gives it. `url` is absolute; its host is the request host. */
export interface CaseRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** A rules manifest in the quant/edge-rules.json format. */
export interface RulesManifest {
  version: 1;
  namespace: string;
  rules: Array<{
    id: string;
    type: 'function' | 'auth' | 'filter';
    urls: string[];
    domains?: string[];
    methods?: string[];
    weight: number;
    disabled?: boolean;
    function_uuid?: string;
    function_ref?: string;
  }>;
}

/** A function as a vector gives it. `body` is the function source (absent for matchRule). */
export interface CaseFunction {
  uuid: string;
  id?: string;
  type: 'function' | 'auth' | 'filter';
  body?: string;
}

/** The answer of every operation except matchRule. Header names are not case sensitive. */
export interface CaseResponse {
  status: number;
  /** One string for each header; set-cookie can be a list of strings. */
  headers: Record<string, string | string[]>;
  bodyText: string;
}

export interface RunFunctionInput {
  uuid: string;
  type: 'function' | 'auth' | 'filter';
  body: string;
  request: CaseRequest;
  /** filter only: the response that the filter gets. */
  response?: { status: number; headers?: Record<string, string>; body?: string | null };
  /** Reserved for KV cases; no vector in this version uses it. */
  kv?: unknown;
}

/**
 * The quant/meta.json document of the site. The vectors use
 * `project_settings.enable_inline_fn` (inline functions on or off).
 */
export interface SiteMeta {
  project_settings?: { enable_inline_fn?: boolean };
  [key: string]: unknown;
}

/**
 * The project settings that are set in the dashboard, not in the site files.
 * A local implementation reads them from a local file.
 */
export interface ProjectSettings {
  /** Project-wide response headers: header name -> value. */
  globalHeaders?: Record<string, string>;
  /** Basic authentication for the whole project. Absent = off. */
  basicAuth?: { username: string; password: string };
  /** 'redirect': a path that ends with / gets a 301 to the path without it. Default 'none'. */
  trailingSlash?: 'redirect' | 'none';
}

export interface ServeSiteInput {
  files?: Record<string, string>;
  functions?: CaseFunction[];
  rules?: RulesManifest;
  /** The quant/meta.json document. Absent = no meta.json. */
  meta?: SiteMeta;
  /** The project settings. Absent = the defaults (no headers, no basic auth, no redirect). */
  project?: ProjectSettings;
  request: CaseRequest;
}

export interface Capabilities {
  /** The operations that the adapter implements. Cases for other operations are skipped. */
  ops: Array<'matchRule' | 'serveStatic' | 'runFunction' | 'serveSite'>;
  /** Cases with any of these tags are skipped. */
  excludeTags?: string[];
}

export interface Adapter {
  capabilities: Capabilities;
  /** The id of the first enabled function or auth rule that matches, or null. */
  matchRule?(rules: RulesManifest, functions: CaseFunction[], request: CaseRequest): Promise<{ ruleId: string | null }>;
  /** Serve the request from the static files only (path -> content, relative to the site root). */
  serveStatic?(files: Record<string, string>, request: CaseRequest): Promise<CaseResponse>;
  /** Run one function for the request, as a rule of its type on every path would. */
  runFunction?(input: RunFunctionInput): Promise<CaseResponse>;
  /** Serve the request from a whole site: files, functions and rules. */
  serveSite?(input: ServeSiteInput): Promise<CaseResponse>;
  dispose?(): Promise<void>;
}

/** A header matcher: exact text, null (absent), a list (in order) or one test. */
export type HeaderMatcher = string | null | string[] | { present: true } | { startsWith: string } | { includes: string };

export interface CaseExpect {
  ruleId?: string | null;
  status?: number;
  headers?: Record<string, HeaderMatcher>;
  bodyText?: string;
  bodyIncludes?: string[];
  bodyExcludes?: string[];
  /** The body parses as JSON and contains these values. */
  bodyJson?: unknown;
}

export interface Case {
  id: string;
  description: string;
  tags: string[];
  op: keyof typeof OPS;
  input: Record<string, unknown>;
  expect: CaseExpect;
  /** Set by loadCases: the suite directory and the file. */
  suite: 'rules' | 'static' | 'functions' | 'inline' | 'project';
  file: string;
}

export interface CaseResult {
  id: string;
  op: string;
  tags: string[];
  file: string;
  status: 'passed' | 'failed' | 'skipped';
  failures: string[];
  reason?: string;
}

export interface RunResult {
  passed: number;
  failed: number;
  skipped: number;
  cases: CaseResult[];
}

export const VECTORS_DIR: string;
export const SUITE_TAGS: Array<'rules' | 'static' | 'functions' | 'inline' | 'project'>;
export const TAGS: string[];
/** The input fields that a case of each operation can have. */
export const INPUT_FIELDS: Record<'matchRule' | 'serveStatic' | 'runFunction' | 'serveSite', string[]>;
/** The fields of the serveSite `project` input. */
export const PROJECT_FIELDS: Array<keyof ProjectSettings>;
/** The problems with a case input (empty when it is valid). The runner fails a case with an invalid input. */
export function inputErrors(item: { op: string; input: unknown }): string[];
export const OPS: Record<'matchRule' | 'serveStatic' | 'runFunction' | 'serveSite', (input: Record<string, unknown>) => unknown[]>;
export function adapterArgs(op: string, input: Record<string, unknown>): unknown[];
export function loadCases(options?: { dir?: string }): Promise<Case[]>;
export function selectCases(cases: Case[], tags?: string[]): Case[];
export function checkResult(expect: CaseExpect, actual: unknown): string[];
export function run(options: { adapter: Adapter; tags?: string[]; cases?: Case[] }): Promise<RunResult>;
