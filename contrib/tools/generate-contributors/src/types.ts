export type ContributorsMap = {
  ensureLogins?: string[];
  displayName?: Record<string, string>;
  nameToLogin?: Record<string, string>;
  emailToLogin?: Record<string, string>;
  seedCommit?: string;
};

export type ApiContributor = {
  login?: string;
  html_url?: string;
  avatar_url?: string;
  name?: string;
  email?: string;
  contributions?: number;
};

export type GitHubUser = {
  login: string;
  htmlUrl: string;
  avatarUrl: string;
};

export type ContributorEntry = GitHubUser & {
  key: string;
  display: string;
  lines: number;
  commits: number;
  pullRequests: number;
  score: number;
  firstCommitDate: string;
};
