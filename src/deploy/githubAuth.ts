export type GitHubRepo = {
  owner: string;
  repo: string;
  fullName: string;
};

export const parseGitHubRepository = (value: string | null): GitHubRepo | null => {
  const raw = (value ?? "").trim();
  const match = raw.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) return null;
  const owner = match[1] ?? "";
  const repo = match[2] ?? "";
  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`
  };
};

export const verifyGitHubRepoAccess = async (params: {
  token: string;
  owner: string;
  repo: string;
  fetchImpl?: typeof fetch;
}) => {
  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${params.token}`,
        "user-agent": "w7s-io-deploy",
        "x-github-api-version": "2022-11-28"
      }
    }
  );

  if (response.ok) return true;
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return false;
  }

  const text = await response.text().catch(() => "");
  throw new Error(text.trim() || `GitHub authorization check failed (${response.status}).`);
};

