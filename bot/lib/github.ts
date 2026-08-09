/**
 * github.ts — client minimal de l'API GitHub (REST v3) pour la tour de contrôle.
 *
 * Deux usages :
 *  - déclencher un workflow (`workflow_dispatch`) avec des inputs ;
 *  - lire / écrire un fichier du dépôt (commit direct via l'API Contents).
 *
 * Auth : GITHUB_PAT (fine-grained ou classic, scope `repo` + `workflow`).
 */

const OWNER = () => process.env.GITHUB_OWNER!;
const REPO = () => process.env.GITHUB_REPO!;
const BRANCH = () => process.env.GITHUB_BRANCH || "main";

function headers() {
  const pat = process.env.GITHUB_PAT;
  if (!pat) throw new Error("GITHUB_PAT manquant");
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

const base = () => `https://api.github.com/repos/${OWNER()}/${REPO()}`;

/** Déclenche un workflow (`workflow_dispatch`). */
export async function dispatchWorkflow(
  workflowFile: string,
  inputs: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${base()}/actions/workflows/${workflowFile}/dispatches`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ref: BRANCH(), inputs }),
  });
  if (!res.ok) {
    throw new Error(`GitHub dispatch ${workflowFile} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

export type RepoFile = { content: string; sha: string };

/** Lit un fichier texte du dépôt. Renvoie null si absent. */
export async function getFile(pathInRepo: string): Promise<RepoFile | null> {
  const res = await fetch(`${base()}/contents/${pathInRepo}?ref=${BRANCH()}`, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub getFile ${pathInRepo} → ${res.status}`);
  const json = (await res.json()) as any;
  return { content: Buffer.from(json.content, "base64").toString("utf8"), sha: json.sha };
}

/** Écrit (crée ou écrase) un fichier texte du dépôt via un commit. */
export async function putFile(pathInRepo: string, content: string, message: string): Promise<void> {
  const existing = await getFile(pathInRepo);
  const res = await fetch(`${base()}/contents/${pathInRepo}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({
      message,
      branch: BRANCH(),
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(existing ? { sha: existing.sha } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub putFile ${pathInRepo} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

/** URL de la page Actions (pour donner un lien de suivi dans Telegram). */
export function actionsUrl(): string {
  return `https://github.com/${OWNER()}/${REPO()}/actions`;
}
