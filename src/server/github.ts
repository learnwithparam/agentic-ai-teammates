import { z } from "zod";
import type { Edition, NewsPublisher } from "./news-shelf";

// Publishes a day of news cards to a GitHub Pages site in one commit, through GitHub's Git data API.
// It is the choice when NEWS_TARGET is github. One Pages site shows one company's news.
// The Pages workflow deploys on each push to news/. The token is fine-grained: Contents read
// and write on one repository, and only the gateway holds it.

const DATA = "news/public/data";
const Days = z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

export class GitHubPublisher implements NewsPublisher {
  constructor(
    private readonly token: string,
    private readonly repository: string,
  ) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("NEWS_REPO must look like owner/name.");
  }

  private async api<T>(route: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`https://api.github.com/repos/${this.repository}${route}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new GitHubError(response.status, body.message ?? response.statusText);
    }
    return (await response.json()) as T;
  }

  private async existingDays(branch: string): Promise<string[]> {
    try {
      const file = await this.api<{ content: string }>(`/contents/${DATA}/days.json?ref=${encodeURIComponent(branch)}`);
      return Days.parse(JSON.parse(Buffer.from(file.content, "base64").toString("utf8")));
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return [];
      throw error;
    }
  }

  // Writes the day's file, today.json and the list of days. Publishing the same edition twice
  // makes no second commit.
  async publish(_company: string, edition: Edition): Promise<{ commit: string | null; url: string }> {
    const { default_branch: branch } = await this.api<{ default_branch: string }>("");
    const ref = await this.api<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(branch)}`);
    const parent = await this.api<{ tree: { sha: string } }>(`/git/commits/${ref.object.sha}`);
    const days = [...new Set([...(await this.existingDays(branch)), edition.day])].sort().reverse();
    const files = {
      [`${DATA}/${edition.day}.json`]: edition,
      [`${DATA}/today.json`]: edition,
      [`${DATA}/days.json`]: days,
    };
    const tree = await this.api<{ sha: string }>("/git/trees", {
      method: "POST",
      body: JSON.stringify({
        base_tree: parent.tree.sha,
        tree: Object.entries(files).map(([path, value]) => ({ path, mode: "100644", type: "blob", content: `${JSON.stringify(value, null, 2)}\n` })),
      }),
    });
    const url = `https://github.com/${this.repository}/tree/${branch}/${DATA}`;
    if (tree.sha === parent.tree.sha) return { commit: null, url };
    const commit = await this.api<{ sha: string }>("/git/commits", {
      method: "POST",
      body: JSON.stringify({ message: `News for ${edition.day}`, tree: tree.sha, parents: [ref.object.sha] }),
    });
    await this.api(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
    return { commit: commit.sha, url };
  }
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`GitHub answered ${status}: ${detail}`);
  }
}
