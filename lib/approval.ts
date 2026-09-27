// Pickup labels are the human approval for automatic runs. The approval covers the
// issue text as it was when the label was applied, not later edits by someone else.

export type ApprovalHistory = {
  labeled: { label: string; actor: string | null; at: string }[];
  renamed: { actor: string | null; at: string }[];
  bodyEditedAt: string | null;
  bodyEditor: string | null;
};

/** Reason the latest approval no longer covers the issue text, or null when it does. */
export function staleApproval(history: ApprovalHistory, approvalLabels: string[]): string | null {
  const wanted = new Set(approvalLabels.map((label) => label.toLowerCase()));
  const approval = history.labeled
    .filter((event) => wanted.has(event.label.toLowerCase()))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (!approval) return 'No record of who applied the pickup label.';
  const after = (at: string | null) => !!at && Date.parse(at) > Date.parse(approval.at);
  const other = (actor: string | null) => !actor || actor !== approval.actor;
  if (after(history.bodyEditedAt) && other(history.bodyEditor))
    return 'Issue description was edited after it was labelled for pickup. Remove and re-apply the label to approve the new text.';
  if (history.renamed.some((event) => after(event.at) && other(event.actor)))
    return 'Issue title changed after it was labelled for pickup. Remove and re-apply the label to approve the new text.';
  return null;
}

type Graphql = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;

type HistoryResponse = {
  repository: { issue: {
    lastEditedAt: string | null;
    editor: { login: string } | null;
    timelineItems: { nodes: ({ __typename: 'LabeledEvent'; createdAt: string; actor: { login: string } | null; label: { name: string } }
      | { __typename: 'RenamedTitleEvent'; createdAt: string; actor: { login: string } | null })[] };
  } | null } | null;
};

export async function approvalHistory(graphql: Graphql, owner: string, repo: string, number: number): Promise<ApprovalHistory> {
  const data = await graphql<HistoryResponse>(`query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) { issue(number: $number) {
      lastEditedAt editor { login }
      timelineItems(last: 100, itemTypes: [LABELED_EVENT, RENAMED_TITLE_EVENT]) { nodes {
        __typename
        ... on LabeledEvent { createdAt actor { login } label { name } }
        ... on RenamedTitleEvent { createdAt actor { login } }
      } }
    } }
  }`, { owner, repo, number });
  const issue = data.repository?.issue;
  if (!issue) throw new Error('Issue history unavailable.');
  const nodes = issue.timelineItems.nodes;
  return {
    labeled: nodes.flatMap((node) => node.__typename === 'LabeledEvent' ? [{ label: node.label.name, actor: node.actor?.login ?? null, at: node.createdAt }] : []),
    renamed: nodes.flatMap((node) => node.__typename === 'RenamedTitleEvent' ? [{ actor: node.actor?.login ?? null, at: node.createdAt }] : []),
    bodyEditedAt: issue.lastEditedAt,
    bodyEditor: issue.editor?.login ?? null,
  };
}
