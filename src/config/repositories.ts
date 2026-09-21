import { readFileSync } from "node:fs";

const REPOSITORY_ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const HTTPS_GITHUB = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
const SSH_GITHUB = /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;

export type RepositoryConfig = Readonly<{
  id: string;
  cloneUrl: string;
  branch?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadRepositories(filePath: string): RepositoryConfig[] {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.repositories)) {
    throw new Error("repositories 설정이 필요함");
  }

  const ids = new Set<string>();
  return parsed.repositories.map((repository): RepositoryConfig => {
    if (!isRecord(repository) || typeof repository.id !== "string" || !REPOSITORY_ID.test(repository.id)) {
      throw new Error("유효하지 않은 저장소 ID");
    }
    if (ids.has(repository.id)) {
      throw new Error("중복된 저장소 ID");
    }
    ids.add(repository.id);

    if (typeof repository.cloneUrl !== "string" || (!HTTPS_GITHUB.test(repository.cloneUrl) && !SSH_GITHUB.test(repository.cloneUrl))) {
      throw new Error("유효하지 않은 GitHub clone URL");
    }
    if (repository.branch !== undefined && (typeof repository.branch !== "string" || repository.branch.trim() === "" || repository.branch.startsWith("-"))) {
      throw new Error("유효하지 않은 브랜치");
    }

    return repository.branch === undefined
      ? { id: repository.id, cloneUrl: repository.cloneUrl }
      : { id: repository.id, cloneUrl: repository.cloneUrl, branch: repository.branch };
  });
}
