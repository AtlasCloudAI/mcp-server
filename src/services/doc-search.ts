import { externalProxyDispatcher } from "./api-client.js";

// atlas_search_docs 以前只在模型目录里按关键词找模型，名字却叫「搜文档」：用户问「怎么上传
// 文件」什么都搜不到，模型还因为名字以为它有用，回答问题前常先白调一次。
//
// 官网给 AI 准备了一份文档索引（/docs/llms.txt）：每篇一行「- [标题](地址.md): 简介」，每篇的
// .md 地址直接返回 Markdown 正文。这里读索引、按需读正文、在内存里打分，不依赖任何搜索服务。
// 索引和正文各缓存一小时；官网暂时不可达时继续用旧缓存，没有缓存才报错。

const DEFAULT_INDEX_URL = "https://www.atlascloud.ai/docs/llms.txt";
const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_DOC_BYTES = 1024 * 1024;
const FETCH_CONCURRENCY = 8;
// 读不到的页面隔这么久再试：首页 /docs/.md 曾经 404，每次查询都重试会拖慢每一次搜索。
const FAILURE_RETRY_MS = 10 * 60 * 1000;
// 一次查询最多等正文这么久；没读完的按标题和简介打分，后台继续读，下一次查询就用得上。
const BODY_WAIT_MS = 4000;
const SNIPPET_CHARS = 320;

export interface DocPage {
  title: string;
  /** 给人看的地址（去掉 .md）。 */
  url: string;
  /** 取正文用的 .md 地址。 */
  markdownUrl: string;
  description: string;
}

export interface DocHit {
  title: string;
  url: string;
  description: string;
  /** 正文里和查询最相关的一段；没有读到正文时为空。 */
  snippet: string;
  score: number;
}

type Fetcher = typeof fetch;

interface Cached<T> {
  value: T;
  fetchedAt: number;
}

let indexCache: Cached<DocPage[]> | null = null;
const bodyCache = new Map<string, Cached<string>>();
const failedAt = new Map<string, number>();
let bodiesInFlight: Promise<void> | null = null;

export function resetDocSearchCacheForTests(): void {
  indexCache = null;
  bodyCache.clear();
  failedAt.clear();
  bodiesInFlight = null;
}

function indexUrl(): URL {
  return new URL(process.env.MCP_DOCS_INDEX_URL?.trim() || DEFAULT_INDEX_URL);
}

async function fetchText(url: string, fetcher: Fetcher): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const dispatcher = externalProxyDispatcher();
    const response = await fetcher(url, {
      signal: controller.signal,
      redirect: "error",
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
    if (!response.ok) throw new Error(`docs fetch ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_DOC_BYTES) throw new Error("docs page too large");
    return new TextDecoder().decode(bytes);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析 llms.txt。只收和索引同一主机、/docs 下、以 .md 结尾的条目：「Optional」一节里的模型库
 * 和 API 参考是网页，不是文档正文。
 */
export function parseDocIndex(text: string, base: URL): DocPage[] {
  const pages: DocPage[] = [];
  const line = /^\s*-\s*\[([^\]]+)\]\((\S+?)\)(?::\s*(.*))?\s*$/;
  for (const raw of text.split("\n")) {
    const match = line.exec(raw);
    if (!match) continue;
    let target: URL;
    try {
      target = new URL(match[2], base);
    } catch {
      continue;
    }
    if (target.host !== base.host || !target.pathname.startsWith("/docs") || !target.pathname.endsWith(".md")) {
      continue;
    }
    const human = new URL(target.toString());
    human.pathname = human.pathname.replace(/\/?\.md$/, "") || "/docs";
    // 索引里首页写成 /docs/.md，官网对它回 404；首页正文其实在 /docs/en.md。
    const markdown = new URL(target.toString());
    if (markdown.pathname === "/docs/.md") markdown.pathname = "/docs/en.md";
    pages.push({
      title: match[1].trim(),
      url: human.toString(),
      markdownUrl: markdown.toString(),
      description: (match[3] ?? "").trim(),
    });
  }
  return pages;
}

async function loadIndex(fetcher: Fetcher, now: number): Promise<DocPage[]> {
  if (indexCache && now - indexCache.fetchedAt < CACHE_TTL_MS) return indexCache.value;
  const base = indexUrl();
  try {
    const pages = parseDocIndex(await fetchText(base.toString(), fetcher), base);
    if (pages.length === 0) throw new Error("docs index has no pages");
    indexCache = { value: pages, fetchedAt: now };
    return pages;
  } catch (error) {
    if (indexCache) return indexCache.value;
    throw error;
  }
}

function refreshBodies(pages: DocPage[], fetcher: Fetcher, now: number): Promise<void> {
  if (bodiesInFlight) return bodiesInFlight;
  const due = pages.filter((page) => {
    const cached = bodyCache.get(page.markdownUrl);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return false;
    const failed = failedAt.get(page.markdownUrl);
    return failed === undefined || now - failed >= FAILURE_RETRY_MS;
  });
  if (due.length === 0) return Promise.resolve();
  bodiesInFlight = (async () => {
    for (let i = 0; i < due.length; i += FETCH_CONCURRENCY) {
      await Promise.all(
        due.slice(i, i + FETCH_CONCURRENCY).map(async (page) => {
          try {
            const text = await fetchText(page.markdownUrl, fetcher);
            bodyCache.set(page.markdownUrl, { value: text, fetchedAt: now });
            failedAt.delete(page.markdownUrl);
          } catch {
            // 读不到的那篇只按标题和简介打分；有旧正文就继续用旧的。
            failedAt.set(page.markdownUrl, now);
          }
        })
      );
    }
  })().finally(() => {
    bodiesInFlight = null;
  });
  return bodiesInFlight;
}

async function loadBodies(
  pages: DocPage[],
  fetcher: Fetcher,
  now: number,
  waitMs: number
): Promise<Map<string, string>> {
  const pending = refreshBodies(pages, fetcher, now);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    pending,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  const out = new Map<string, string>();
  for (const page of pages) {
    const cached = bodyCache.get(page.markdownUrl);
    if (cached) out.set(page.markdownUrl, cached.value);
  }
  return out;
}

/** 服务启动时在后台把索引和正文读进缓存，第一个用户不用等。失败了就等第一次查询再读。 */
export function prewarmDocSearch(fetcher: Fetcher = fetch): void {
  const now = Date.now();
  loadIndex(fetcher, now)
    .then((pages) => refreshBodies(pages, fetcher, now))
    .catch(() => {});
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "can", "do", "does", "for", "from", "get", "how", "i", "in", "into",
  "is", "it", "me", "my", "of", "on", "or", "the", "to", "use", "what", "when", "where", "which",
  "why", "with", "you", "your", "atlas", "cloud", "atlascloud",
]);

export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g) ?? [];
  const terms = words
    .map((word) => word.replace(/[.-]+$/, ""))
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
  return [...new Set(terms)];
}

// 词形只做最粗的归一：files/uploading/refunded 都能对上 file/upload/refund。
function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/, "");
}

function countTerm(haystack: string, term: string): number {
  const root = stem(term);
  if (root.length < 2) return 0;
  const pattern = new RegExp(`\\b${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
  return haystack.match(pattern)?.length ?? 0;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^import .*$/gm, "")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_>#|]/g, " ");
}

/** 正文里命中查询词最多的一段（按空行分段），截到 SNIPPET_CHARS。 */
export function bestSnippet(body: string, terms: string[], description = ""): string {
  const summary = description.replace(/\s+/g, " ").trim().toLowerCase();
  let best = "";
  let bestHits = 0;
  for (const block of body.split(/\n\s*\n/)) {
    // 片段要的是能回答问题的正文，标题行、Source 行、组件 import 不算。
    if (/^\s*(import |Source: )/.test(block)) continue;
    if (/^\s*#{1,6}\s/.test(block) && !block.trim().includes("\n")) continue;
    const plain = stripMarkdown(block).replace(/\s+/g, " ").trim();
    if (plain.length < 20) continue;
    const lower = plain.toLowerCase();
    // 每篇开头都有一段和索引简介相同的导语，结果里已经带了简介，片段要给正文。
    if (summary && lower === summary) continue;
    const hits = terms.reduce((sum, term) => sum + (countTerm(lower, term) > 0 ? 1 : 0), 0);
    if (hits > bestHits) {
      best = plain;
      bestHits = hits;
    }
  }
  return best.length > SNIPPET_CHARS ? `${best.slice(0, SNIPPET_CHARS - 1).trimEnd()}…` : best;
}

export function scorePage(page: DocPage, body: string | undefined, terms: string[], phrase: string): number {
  const title = page.title.toLowerCase();
  const description = page.description.toLowerCase();
  const path = new URL(page.markdownUrl).pathname.toLowerCase().replace(/[/_-]/g, " ");
  const text = body ? stripMarkdown(body).toLowerCase() : "";
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    const inTitle = countTerm(title, term) > 0;
    const inDescription = countTerm(description, term) > 0;
    const inPath = countTerm(path, term) > 0;
    const inBody = countTerm(text, term);
    if (inTitle || inDescription || inPath || inBody > 0) matched += 1;
    score += (inTitle ? 6 : 0) + (inDescription ? 3 : 0) + (inPath ? 2 : 0) + Math.min(inBody, 4);
  }
  if (matched === 0) return 0;
  // 命中的词越全越靠前：「upload file」两个词都中的页要排在只中一个的前面。
  score *= matched / terms.length;
  if (phrase.length > 3 && (title.includes(phrase) || text.includes(phrase))) score += 5;
  return score;
}

export async function searchDocs(
  query: string,
  options: { limit?: number; fetcher?: Fetcher; now?: number; waitMs?: number } = {}
): Promise<DocHit[]> {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now();
  const pages = await loadIndex(fetcher, now);
  const bodies = await loadBodies(pages, fetcher, now, options.waitMs ?? BODY_WAIT_MS);
  const phrase = terms.join(" ");
  const ranked = pages
    .map((page) => {
      const body = bodies.get(page.markdownUrl);
      return { page, body, score: scorePage(page, body, terms, phrase) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 5);
  return ranked.map(({ page, body, score }) => ({
    title: page.title,
    url: page.url,
    description: page.description,
    snippet: body ? bestSnippet(body, terms, page.description) : "",
    score: Math.round(score * 10) / 10,
  }));
}
