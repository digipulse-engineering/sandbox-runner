import { parseRepositoryRequest, validGitReference } from "./run-input-validation.mjs";

export { parseRepositoryRequest, validGitReference };

export type RepositoryInput = { slug: string; sha: string };
export type RepositoryReference = { slug: string; ref: string };
export type RepositoryRequest = RepositoryInput | RepositoryReference;

type RequestedSource = { repository?: RepositoryInput; repositoryRef?: RepositoryReference };

export function parseRepository(value: unknown): RepositoryInput | undefined {
  const source = parseRepositoryRequest(value);
  return source && "sha" in source ? source : undefined;
}

export function sameRepository(left?: RepositoryInput, right?: RepositoryInput): boolean {
  return left?.slug === right?.slug && left?.sha === right?.sha;
}

export function sameRequestedSource(left: RequestedSource, right: RequestedSource): boolean {
  const reference = left.repositoryRef;
  const requested = right.repositoryRef;
  return reference || requested ? reference?.slug === requested?.slug && reference?.ref === requested?.ref
    : sameRepository(left.repository, right.repository);
}
