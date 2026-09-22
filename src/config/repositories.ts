import { readFileSync } from "node:fs";

const ID_SEGMENT = "[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?";
const REPOSITORY_ID = new RegExp(`^(?:${ID_SEGMENT})(?:/${ID_SEGMENT})?$`);
const HTTPS_GITHUB = /^https:\/\/(?:github\.com|github\.gmarket\.com)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
const SSH_GITHUB = /^git@(?:github\.com|github\.gmarket\.com):[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;

export type RepositoryConfig = Readonly<{
  id: string;
  cloneUrl: string;
  branch?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inferRepositoryId(cloneUrl: string): string {
  const path = cloneUrl.startsWith("https://")
    ? new URL(cloneUrl).pathname.slice(1)
    : cloneUrl.slice(cloneUrl.indexOf(":") + 1);
  const [organization, repository] = path.split("/");
  return `${organization}/${repository!.replace(/\.git$/, "")}`;
}

export function loadRepositories(filePath: string): RepositoryConfig[] {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.repositories)) {
    throw new Error("repositories 설정이 필요함");
  }

  const ids = new Set<string>();
  return parsed.repositories.map((repository): RepositoryConfig => {
    if (!isRecord(repository)) {
      throw new Error("유효하지 않은 저장소 설정");
    }
    if (typeof repository.cloneUrl !== "string" || (!HTTPS_GITHUB.test(repository.cloneUrl) && !SSH_GITHUB.test(repository.cloneUrl))) {
      throw new Error("유효하지 않은 GitHub clone URL");
    }
    const id = repository.id === undefined ? inferRepositoryId(repository.cloneUrl) : repository.id;
    if (typeof id !== "string" || !REPOSITORY_ID.test(id)) {
      throw new Error("유효하지 않은 저장소 ID");
    }
    if (ids.has(id)) {
      throw new Error("중복된 저장소 ID");
    }
    ids.add(id);

    if (repository.branch !== undefined && (typeof repository.branch !== "string" || repository.branch.trim() === "" || repository.branch.startsWith("-"))) {
      throw new Error("유효하지 않은 브랜치");
    }

    return repository.branch === undefined
      ? { id, cloneUrl: repository.cloneUrl }
      : { id, cloneUrl: repository.cloneUrl, branch: repository.branch };
  });
}
