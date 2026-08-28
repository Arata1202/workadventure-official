import { describe, expect, it } from "vitest";

import type { ContributorEntry, GitHubUser } from "../src/types.js";

import {
  computeScore,
  CONTRIBUTORS_END,
  CONTRIBUTORS_HIDDEN_END,
  CONTRIBUTORS_HIDDEN_START,
  CONTRIBUTORS_START,
  normalizeAvatar,
  parseGitHistory,
  parseHiddenLogins,
  parsePaginatedJson,
  readBoundedResponse,
  readImageDimensions,
  resolveLogin,
  updateReadme,
} from "../src/update-contributors.js";

const user = (login: string): GitHubUser => ({
  login,
  htmlUrl: `https://github.com/${login}`,
  avatarUrl: `https://avatars.githubusercontent.com/u/1?v=4&s=48`,
});

const entry = (login: string, score: number): ContributorEntry => ({
  ...user(login),
  key: login.toLowerCase(),
  display: login,
  lines: 100,
  commits: 10,
  pullRequests: 2,
  score,
  firstCommitDate: "2020-01-01",
});

describe("parsePaginatedJson", () => {
  it("flattens compact and formatted GitHub API pages", () => {
    const result = parsePaginatedJson(
      '[{"login":"first"}]\n[\n  {"login":"second"}\n]',
    );

    expect(result).toEqual([{ login: "first" }, { login: "second" }]);
  });

  it("rejects incomplete GitHub API output", () => {
    expect(() => parsePaginatedJson('[{"login":"first"}')).toThrow(
      "incomplete JSON",
    );
  });
});

describe("resolveLogin", () => {
  const users = new Map([["octocat", user("octocat")]]);

  it("resolves GitHub noreply addresses", () => {
    expect(
      resolveLogin(
        "The Octocat",
        "123+octocat@users.noreply.github.com",
        users,
        {},
        {},
      ),
    ).toBe("octocat");
  });

  it("uses explicit email mappings before heuristics", () => {
    expect(
      resolveLogin(
        "Different Name",
        "author@example.com",
        users,
        {},
        { "author@example.com": "octocat" },
      ),
    ).toBe("octocat");
  });

  it("rejects invalid mapped logins", () => {
    expect(
      resolveLogin("Unknown", null, users, { unknown: "invalid--login" }, {}),
    ).toBeNull();
  });
});

describe("parseGitHistory", () => {
  it("counts source changes, records first contribution, and ignores docs", () => {
    const users = new Map([["octocat", user("octocat")]]);
    const log = [
      "Octocat\x1foctocat@users.noreply.github.com\x1f2020-01-02T10:00:00Z",
      "10\t2\tsrc/index.ts",
      "100\t0\tdocs/generated.md",
      "Octocat\x1foctocat@users.noreply.github.com\x1f2021-03-04T10:00:00Z",
      "3\t1\tsrc/next.ts",
    ].join("\n");

    const result = parseGitHistory(log, users, {}, {});

    expect(result.linesByLogin.get("octocat")).toBe(16);
    expect(result.firstCommitByLogin.get("octocat")).toBe("2020-01-02");
  });
});

describe("computeScore", () => {
  it("uses the OpenClaw contribution and tenure formula", () => {
    const repositoryEpoch = new Date("2020-01-01").getTime();
    const now = new Date("2024-01-01").getTime();

    const score = computeScore(100, 5, 2, "2020-01-01", {
      repositoryEpoch,
      now,
    });

    expect(score).toBe(60);
  });

  it("does not grant a tenure bonus without a first commit date", () => {
    const score = computeScore(100, 5, 2, "", {
      repositoryEpoch: new Date("2020-01-01").getTime(),
      now: new Date("2024-01-01").getTime(),
    });

    expect(score).toBe(40);
  });
});

describe("avatar handling", () => {
  it("normalizes GitHub avatar size parameters", () => {
    expect(
      normalizeAvatar("https://avatars.githubusercontent.com/u/1?v=4&size=96"),
    ).toBe("https://avatars.githubusercontent.com/u/1?v=4&s=48");
  });

  it("reads PNG dimensions", () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(40, 16);
    png.writeUInt32BE(48, 20);

    expect(readImageDimensions(png)).toEqual({ width: 40, height: 48 });
  });

  it("returns null for unsupported image data", () => {
    expect(readImageDimensions(Buffer.from("not an image"))).toBeNull();
  });

  it("rejects oversized avatar responses from their content length", async () => {
    const response = new Response(new Uint8Array(), {
      headers: { "content-length": String(256 * 1024 + 1) },
    });

    await expect(readBoundedResponse(response)).rejects.toThrow(
      "exceeded 262144 bytes",
    );
  });

  it("rejects streamed avatar responses that exceed the byte limit", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(256 * 1024));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
    );

    await expect(readBoundedResponse(response)).rejects.toThrow(
      "exceeded 262144 bytes",
    );
  });
});

describe("README updates", () => {
  it("updates only contributor blocks and keeps hidden logins stable", () => {
    const readme = [
      "# WorkAdventure",
      "",
      CONTRIBUTORS_START,
      CONTRIBUTORS_END,
      CONTRIBUTORS_HIDDEN_START,
      "default-avatar-cache: hidden",
      "hidden-user",
      CONTRIBUTORS_HIDDEN_END,
      "",
      "## Community resources",
    ].join("\n");
    const visible = entry("visible-user", 20);
    const hidden = entry("hidden-user", 10);

    const updated = updateReadme(readme, [visible, hidden], [visible]);

    expect(updated).toContain(
      "[![visible-user](https://avatars.githubusercontent.com/u/1?v=4&s=48)](https://github.com/visible-user)",
    );
    expect(parseHiddenLogins(updated)).toEqual(["hidden-user"]);
    expect(updated).toContain(
      `${CONTRIBUTORS_HIDDEN_END}\n\n## Community resources`,
    );
  });

  it("fails without explicit README markers", () => {
    expect(() => updateReadme("# WorkAdventure", [], [])).toThrow(
      "missing the contributors block",
    );
  });
});
