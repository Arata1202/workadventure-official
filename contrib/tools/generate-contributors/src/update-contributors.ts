#!/usr/bin/env tsx

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  ApiContributor,
  ContributorEntry,
  ContributorsMap,
  GitHubUser,
} from "./types.js";

export const REPOSITORY = "workadventure/workadventure";
export const CONTRIBUTORS_START = "<!-- contributors:start -->";
export const CONTRIBUTORS_END = "<!-- contributors:end -->";
export const CONTRIBUTORS_HIDDEN_START = "<!-- contributors:hidden:start";
export const CONTRIBUTORS_HIDDEN_END = "contributors:hidden:end -->";

const CONTRIBUTORS_PER_LINE = 10;
const AVATAR_SIZE = 48;
const AVATAR_PROBE_SIZE = 40;
const AVATAR_PROBE_MAX_BYTES = 256 * 1024;
const AVATAR_PROBE_TIMEOUT_MS = 8_000;
const GH_COMMAND_TIMEOUT_MS = 120_000;

const toolDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(toolDirectory, "../../..");
const readmePath = resolve(repositoryRoot, "README.md");
const mapPath = resolve(toolDirectory, "contributors-map.json");

type GitHistory = {
  linesByLogin: Map<string, number>;
  firstCommitByLogin: Map<string, string>;
};

type ReadmeEntry = {
  display: string;
  htmlUrl: string;
  avatarUrl: string;
};

type ScoreContext = {
  repositoryEpoch: number;
  now: number;
};

export function parsePaginatedJson(raw: string): unknown[] {
  const values: unknown[] = [];
  const decoder = new JsonValueDecoder(raw);
  for (;;) {
    const value = decoder.next();
    if (value === undefined) {
      return values;
    }
    if (Array.isArray(value)) {
      values.push(...value);
    } else {
      values.push(value);
    }
  }
}

class JsonValueDecoder {
  private offset = 0;

  public constructor(private readonly input: string) {}

  public next(): unknown | undefined {
    while (/\s/u.test(this.input[this.offset] ?? "")) {
      this.offset += 1;
    }
    if (this.offset >= this.input.length) {
      return undefined;
    }

    const start = this.offset;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; this.offset < this.input.length; this.offset += 1) {
      const character = this.input[this.offset];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "[" || character === "{") {
        depth += 1;
      } else if (character === "]" || character === "}") {
        depth -= 1;
        if (depth === 0) {
          this.offset += 1;
          return JSON.parse(this.input.slice(start, this.offset));
        }
      }
    }
    throw new Error("GitHub CLI returned incomplete JSON");
  }
}

export function normalizeLogin(
  login: string | null | undefined,
): string | null {
  const trimmed = login?.trim();
  if (!trimmed || !/^[A-Za-z0-9-]{1,39}$/u.test(trimmed)) {
    return null;
  }
  if (
    trimmed.startsWith("-") ||
    trimmed.endsWith("-") ||
    trimmed.includes("--")
  ) {
    return null;
  }
  return trimmed;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function normalizeIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function normalizeMap(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map).map(([key, value]) => [normalizeName(key), value]),
  );
}

export function resolveLogin(
  name: string,
  email: string | null,
  usersByLogin: ReadonlyMap<string, GitHubUser>,
  nameToLogin: Readonly<Record<string, string>>,
  emailToLogin: Readonly<Record<string, string>>,
): string | null {
  if (email) {
    const mapped = emailToLogin[email.toLowerCase()];
    if (mapped) {
      return normalizeLogin(mapped);
    }

    const localPart = email.split("@", 1)[0];
    if (localPart && email.endsWith("@users.noreply.github.com")) {
      return normalizeLogin(
        localPart.includes("+") ? localPart.split("+")[1] : localPart,
      );
    }
    if (
      localPart &&
      email.endsWith("@github.com") &&
      usersByLogin.has(localPart.toLowerCase())
    ) {
      return normalizeLogin(localPart);
    }

    if (
      localPart &&
      normalizeIdentifier(localPart) === normalizeIdentifier(name)
    ) {
      for (const candidate of [localPart, localPart.replace(/[._-]/gu, "")]) {
        if (usersByLogin.has(candidate.toLowerCase())) {
          return normalizeLogin(candidate);
        }
      }
    }
  }

  const normalizedName = normalizeName(name);
  const compactName = normalizedName.replace(/\s+/gu, "");
  const mapped = nameToLogin[normalizedName] ?? nameToLogin[compactName];
  if (mapped) {
    return normalizeLogin(mapped);
  }
  if (usersByLogin.has(normalizedName)) {
    return normalizeLogin(normalizedName);
  }
  if (usersByLogin.has(compactName)) {
    return normalizeLogin(compactName);
  }
  return null;
}

export function parseGitHistory(
  log: string,
  usersByLogin: ReadonlyMap<string, GitHubUser>,
  nameToLogin: Readonly<Record<string, string>>,
  emailToLogin: Readonly<Record<string, string>>,
): GitHistory {
  const linesByLogin = new Map<string, number>();
  const firstCommitByLogin = new Map<string, string>();
  let currentName: string | null = null;
  let currentEmail: string | null = null;

  for (const line of log.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    if (line.includes("\x1f") && !/^[0-9-]/u.test(line)) {
      const [name, email, date] = line.split("\x1f", 3);
      currentName = name?.trim() || null;
      currentEmail = email?.trim().toLowerCase() || null;
      if (currentName && date) {
        const login = resolveLogin(
          currentName,
          currentEmail,
          usersByLogin,
          nameToLogin,
          emailToLogin,
        );
        if (login && !firstCommitByLogin.has(login.toLowerCase())) {
          firstCommitByLogin.set(login.toLowerCase(), date.slice(0, 10));
        }
      }
      continue;
    }
    if (!currentName) {
      continue;
    }
    const [additions, deletions, filePath] = line.split("\t", 3);
    if (!filePath || filePath.startsWith("docs/")) {
      continue;
    }
    const changedLines = parseCount(additions) + parseCount(deletions);
    if (changedLines === 0) {
      continue;
    }
    const login = resolveLogin(
      currentName,
      currentEmail,
      usersByLogin,
      nameToLogin,
      emailToLogin,
    );
    if (login) {
      const key = login.toLowerCase();
      linesByLogin.set(key, (linesByLogin.get(key) ?? 0) + changedLines);
    }
  }
  return { linesByLogin, firstCommitByLogin };
}

function parseCount(value: string | undefined): number {
  return value && /^\d+$/u.test(value) ? Number(value) : 0;
}

export function computeScore(
  lines: number,
  commits: number,
  pullRequests: number,
  firstCommitDate: string,
  context: ScoreContext,
): number {
  const repositoryAgeDays = Math.max(
    1,
    (context.now - context.repositoryEpoch) / 86_400_000,
  );
  const contributorAgeDays = firstCommitDate
    ? Math.max(
        0,
        (context.now - new Date(firstCommitDate).getTime()) / 86_400_000,
      )
    : 0;
  const tenureRatio = Math.min(1, contributorAgeDays / repositoryAgeDays);
  const tenure = 1 + tenureRatio * tenureRatio * 0.5;
  return (commits * 2 + pullRequests * 10 + Math.sqrt(lines)) * tenure;
}

export function normalizeAvatar(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("s");
    parsed.searchParams.delete("size");
    parsed.searchParams.set("s", String(AVATAR_SIZE));
    return parsed.toString();
  } catch {
    return url;
  }
}

export function readImageDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === undefined) {
      return null;
    }
    offset += 2;
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (offset + 2 > buffer.length) {
      return null;
    }
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) {
      return null;
    }
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return length >= 7
        ? {
            height: buffer.readUInt16BE(offset + 3),
            width: buffer.readUInt16BE(offset + 5),
          }
        : null;
    }
    offset += length;
  }
  return null;
}

export async function readBoundedResponse(response: Response): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength)) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed > AVATAR_PROBE_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Avatar probe exceeded ${AVATAR_PROBE_MAX_BYTES} bytes`);
    }
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > AVATAR_PROBE_MAX_BYTES) {
      throw new Error(`Avatar probe exceeded ${AVATAR_PROBE_MAX_BYTES} bytes`);
    }
    return buffer;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return Buffer.concat(chunks, total);
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > AVATAR_PROBE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Avatar probe exceeded ${AVATAR_PROBE_MAX_BYTES} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
}

async function usesDefaultAvatar(login: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://github.com/${login}.png?size=${AVATAR_PROBE_SIZE}`,
      {
        headers: { "user-agent": "workadventure-contributors" },
        signal: AbortSignal.timeout(AVATAR_PROBE_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return false;
    }
    const dimensions = readImageDimensions(await readBoundedResponse(response));
    return Boolean(
      dimensions &&
      (dimensions.width > AVATAR_PROBE_SIZE ||
        dimensions.height > AVATAR_PROBE_SIZE),
    );
  } catch {
    return false;
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) {
        return;
      }
      const value = values[index];
      if (value !== undefined) {
        output[index] = await transform(value);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return output;
}

function findRange(
  content: string,
  startMarker: string,
  endMarker: string,
): { start: number; end: number } | null {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start);
  return start === -1 || end === -1
    ? null
    : { start, end: end + endMarker.length };
}

export function parseHiddenLogins(content: string): string[] {
  const range = findRange(
    content,
    CONTRIBUTORS_HIDDEN_START,
    CONTRIBUTORS_HIDDEN_END,
  );
  if (!range) {
    return [];
  }
  return content
    .slice(range.start, range.end)
    .split("\n")
    .map((line) => normalizeLogin(line.trim())?.toLowerCase() ?? null)
    .filter((login): login is string => login !== null);
}

function parseReadmeEntries(content: string): ReadmeEntry[] {
  const range = findRange(content, CONTRIBUTORS_START, CONTRIBUTORS_END);
  if (!range) {
    return [];
  }
  const entries: ReadmeEntry[] = [];
  const markdown = /\[!\[([^\]]+)\]\(([^)]+)\)\]\(([^)]+)\)/gu;
  for (const match of content
    .slice(range.start, range.end)
    .matchAll(markdown)) {
    const [, display, avatarUrl, htmlUrl] = match;
    if (display && avatarUrl && htmlUrl) {
      entries.push({
        display: display.replace(/\\([\\[\]])/gu, "$1"),
        avatarUrl,
        htmlUrl,
      });
    }
  }
  return entries;
}

function loginFromUrl(url: string): string | null {
  const match = /^https?:\/\/github\.com\/([^/?#]+)/iu.exec(url);
  return normalizeLogin(match?.[1]);
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]])/gu, "\\$1");
}

function renderVisibleEntries(entries: readonly ContributorEntry[]): string {
  const lines: string[] = [];
  for (let index = 0; index < entries.length; index += CONTRIBUTORS_PER_LINE) {
    lines.push(
      entries
        .slice(index, index + CONTRIBUTORS_PER_LINE)
        .map(
          (entry) =>
            `[![${escapeMarkdownLabel(entry.display)}](${entry.avatarUrl})](${entry.htmlUrl})`,
        )
        .join(" "),
    );
  }
  return `${CONTRIBUTORS_START}\n${lines.join("\n")}\n${CONTRIBUTORS_END}`;
}

function renderHiddenEntries(
  entries: readonly ContributorEntry[],
  visibleEntries: readonly ContributorEntry[],
): string {
  const visible = new Set(
    visibleEntries.map((entry) => entry.login.toLowerCase()),
  );
  const hidden = entries
    .map((entry) => entry.login.toLowerCase())
    .filter((login) => !visible.has(login))
    .toSorted((left, right) => left.localeCompare(right));
  const notice =
    "default-avatar-cache: hidden from the rendered wall because these users still use GitHub's default avatar";
  return `${CONTRIBUTORS_HIDDEN_START}\n${notice}${hidden.length > 0 ? `\n${hidden.join("\n")}` : ""}\n${CONTRIBUTORS_HIDDEN_END}\n`;
}

export function updateReadme(
  currentReadme: string,
  entries: readonly ContributorEntry[],
  visibleEntries: readonly ContributorEntry[],
): string {
  const hiddenRange = findRange(
    currentReadme,
    CONTRIBUTORS_HIDDEN_START,
    CONTRIBUTORS_HIDDEN_END,
  );
  const withoutHidden = hiddenRange
    ? `${currentReadme.slice(0, hiddenRange.start)}${currentReadme.slice(hiddenRange.end)}`
    : currentReadme;
  const visibleRange = findRange(
    withoutHidden,
    CONTRIBUTORS_START,
    CONTRIBUTORS_END,
  );
  if (!visibleRange) {
    throw new Error("README.md is missing the contributors block");
  }
  const visibleBlock = renderVisibleEntries(visibleEntries);
  const hiddenBlock = renderHiddenEntries(entries, visibleEntries);
  const suffix = withoutHidden.slice(visibleRange.end).replace(/^\n+/u, "");
  return `${withoutHidden.slice(0, visibleRange.start)}${visibleBlock}\n${hiddenBlock}\n${suffix}`;
}

function run(file: string, args: string[]): string {
  return execFileSync(file, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 200 * 1024 * 1024,
    timeout: file === "gh" ? GH_COMMAND_TIMEOUT_MS : undefined,
    killSignal: "SIGKILL",
  }).trim();
}

function fetchUser(login: string): GitHubUser | null {
  const normalized = normalizeLogin(login);
  if (!normalized) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(
      run("gh", ["api", `users/${normalized}`]),
    );
    if (!isApiUser(value)) {
      return null;
    }
    return {
      login: value.login,
      htmlUrl: value.html_url,
      avatarUrl: normalizeAvatar(value.avatar_url),
    };
  } catch {
    return null;
  }
}

function isApiUser(
  value: unknown,
): value is ApiContributor &
  Required<Pick<ApiContributor, "login" | "html_url" | "avatar_url">> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.login === "string" &&
    typeof candidate.html_url === "string" &&
    typeof candidate.avatar_url === "string"
  );
}

function pickDisplay(
  config: ContributorsMap,
  baseName: string | null | undefined,
  login: string,
  existing?: string,
): string {
  return (
    config.displayName?.[login.toLowerCase()] ?? existing ?? baseName ?? login
  );
}

function addOrUpdateEntry(
  entries: Map<string, ContributorEntry>,
  user: GitHubUser,
  display: string,
  lines: number,
  commits: number,
  pullRequests: number,
  firstCommitDate: string,
  context: ScoreContext,
): void {
  const key = user.login.toLowerCase();
  const score = computeScore(
    lines,
    commits,
    pullRequests,
    firstCommitDate,
    context,
  );
  const existing = entries.get(key);
  if (!existing) {
    entries.set(key, {
      ...user,
      key,
      display,
      lines,
      commits,
      pullRequests,
      firstCommitDate,
      score,
    });
    return;
  }
  existing.login = user.login;
  existing.htmlUrl = user.htmlUrl;
  existing.avatarUrl = user.avatarUrl;
  existing.display ||= display;
  existing.lines = Math.max(existing.lines, lines);
  existing.commits = Math.max(existing.commits, commits);
  existing.pullRequests = Math.max(existing.pullRequests, pullRequests);
  existing.firstCommitDate ||= firstCommitDate;
  existing.score = Math.max(existing.score, score);
}

export async function main(): Promise<void> {
  const config = JSON.parse(readFileSync(mapPath, "utf8")) as ContributorsMap;
  const nameToLogin = normalizeMap(config.nameToLogin ?? {});
  const emailToLogin = Object.fromEntries(
    Object.entries(config.emailToLogin ?? {}).map(([email, login]) => [
      email.toLowerCase(),
      login,
    ]),
  );
  const ensureLogins = (config.ensureLogins ?? []).map((login) =>
    login.toLowerCase(),
  );
  const currentReadme = readFileSync(readmePath, "utf8");

  const apiValues = parsePaginatedJson(
    run("gh", [
      "api",
      `repos/${REPOSITORY}/contributors?per_page=100&anon=1`,
      "--paginate",
    ]),
  );
  const apiContributors = apiValues.filter((value): value is ApiContributor =>
    Boolean(value && typeof value === "object"),
  );
  const usersByLogin = new Map<string, GitHubUser>();
  const commitsByLogin = new Map<string, number>();
  for (const contributor of apiContributors) {
    if (!isApiUser(contributor)) {
      continue;
    }
    const user = {
      login: contributor.login,
      htmlUrl: contributor.html_url,
      avatarUrl: normalizeAvatar(contributor.avatar_url),
    };
    usersByLogin.set(user.login.toLowerCase(), user);
    if (typeof contributor.contributions === "number") {
      commitsByLogin.set(user.login.toLowerCase(), contributor.contributions);
    }
  }
  for (const login of ensureLogins) {
    if (!usersByLogin.has(login)) {
      const user = fetchUser(login);
      if (user) {
        usersByLogin.set(user.login.toLowerCase(), user);
      }
    }
  }

  const history = parseGitHistory(
    run("git", ["log", "--reverse", "--format=%aN%x1f%aE%x1f%aI", "--numstat"]),
    usersByLogin,
    nameToLogin,
    emailToLogin,
  );
  for (const login of ensureLogins) {
    history.linesByLogin.set(login, history.linesByLogin.get(login) ?? 0);
  }

  const pullRequestsByLogin = new Map<string, number>();
  const pullRequestAuthors = run("gh", [
    "pr",
    "list",
    "-R",
    REPOSITORY,
    "--state",
    "merged",
    "--limit",
    "5000",
    "--json",
    "author",
    "--jq",
    ".[].author.login",
  ]);
  for (const login of pullRequestAuthors.split("\n")) {
    const key = login.trim().toLowerCase();
    if (key) {
      pullRequestsByLogin.set(key, (pullRequestsByLogin.get(key) ?? 0) + 1);
    }
  }

  const rootCommit = run("git", ["rev-list", "--max-parents=0", "HEAD"]).split(
    "\n",
  )[0];
  if (!rootCommit) {
    throw new Error("Could not determine the repository root commit");
  }
  const repositoryEpoch = new Date(
    run("git", ["log", "--format=%aI", "-1", rootCommit]).slice(0, 10),
  ).getTime();
  const now = new Date(new Date().toISOString().slice(0, 10)).getTime();
  const scoreContext = { repositoryEpoch, now };
  const entries = new Map<string, ContributorEntry>();

  if (config.seedCommit) {
    const seedReadme = run("git", ["show", `${config.seedCommit}:README.md`]);
    for (const seed of parseReadmeEntries(seedReadme)) {
      const login = loginFromUrl(seed.htmlUrl);
      const user = login
        ? (usersByLogin.get(login.toLowerCase()) ?? fetchUser(login))
        : null;
      if (user) {
        addOrUpdateEntry(
          entries,
          user,
          seed.display,
          0,
          0,
          0,
          "",
          scoreContext,
        );
      }
    }
  }

  for (const contributor of apiContributors) {
    const baseName =
      contributor.name?.trim() ||
      contributor.email?.trim() ||
      contributor.login?.trim();
    if (!baseName) {
      continue;
    }
    const login = contributor.login
      ? normalizeLogin(contributor.login)
      : resolveLogin(
          baseName,
          contributor.email ?? null,
          usersByLogin,
          nameToLogin,
          emailToLogin,
        );
    if (!login) {
      continue;
    }
    const key = login.toLowerCase();
    const user = usersByLogin.get(key) ?? fetchUser(login);
    if (!user) {
      continue;
    }
    usersByLogin.set(key, user);
    const lines = history.linesByLogin.get(key) ?? 0;
    const commits = commitsByLogin.get(key) ?? 0;
    const pullRequests = pullRequestsByLogin.get(key) ?? 0;
    const firstCommitDate = history.firstCommitByLogin.get(key) ?? "";
    addOrUpdateEntry(
      entries,
      user,
      pickDisplay(config, baseName, user.login, entries.get(key)?.display),
      lines,
      commits,
      pullRequests,
      firstCommitDate,
      scoreContext,
    );
  }

  for (const [key, lines] of history.linesByLogin) {
    if (entries.has(key)) {
      continue;
    }
    const user = usersByLogin.get(key) ?? fetchUser(key);
    if (user) {
      addOrUpdateEntry(
        entries,
        user,
        pickDisplay(config, null, user.login),
        lines,
        commitsByLogin.get(key) ?? 0,
        pullRequestsByLogin.get(key) ?? 0,
        history.firstCommitByLogin.get(key) ?? "",
        scoreContext,
      );
    }
  }

  const allEntries = [...entries.values()];
  const previouslyHidden = new Set(parseHiddenLogins(currentReadme));
  const visibleFlags = await mapWithConcurrency(
    allEntries,
    8,
    async (entry) => {
      return (
        !previouslyHidden.has(entry.login.toLowerCase()) &&
        !(await usesDefaultAvatar(entry.login))
      );
    },
  );
  const visibleEntries = allEntries
    .filter((_entry, index) => visibleFlags[index])
    .toSorted(
      (left, right) =>
        right.score - left.score || left.display.localeCompare(right.display),
    );

  writeFileSync(
    readmePath,
    updateReadme(currentReadme, allEntries, visibleEntries),
    "utf8",
  );
  console.log(
    `Updated README contributors: ${visibleEntries.length} visible (${allEntries.length - visibleEntries.length} default-avatar entries hidden)`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    console.error("Failed to update contributors", error);
    process.exitCode = 1;
  });
}
