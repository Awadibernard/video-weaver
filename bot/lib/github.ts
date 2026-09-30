import { CONFIG } from "./env";

const USER_AGENT = "VideoWeaverBot/2.0";

/**
 * Déclenche un workflow GitHub Actions (render.yml ou cron.yml)
 */
export async function triggerWorkflow(workflowFileName: string, inputs: Record<string, string> = {}): Promise<boolean> {
  const url = `https://api.github.com/repos/${CONFIG.repoOwner}/${CONFIG.repoName}/actions/workflows/${workflowFileName}/dispatches`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.ghPat}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: CONFIG.defaultBranch,
      inputs,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`❌ Erreur déclenchement workflow (${workflowFileName}): HTTP ${response.status} -${errorText}`);
    return false;
  }

  return true;
}

/**
 * Réinitialise la liste des thèmes utilisés dans history.json directement sur GitHub
 */
export async function resetHistoryTopicsOnGitHub(): Promise<{ success: boolean; message: string }> {
  const filePath = "history.json";
  const getUrl = `https://api.github.com/repos/${CONFIG.repoOwner}/${CONFIG.repoName}/contents/${filePath}?ref=${CONFIG.defaultBranch}`;

  const headers = {
    Authorization: `Bearer ${CONFIG.ghPat}`,
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  try {
    // 1. Récupérer le SHA actuel du fichier history.json
    const getRes = await fetch(getUrl, { headers });
    let sha: string | undefined;

    if (getRes.ok) {
      const fileData: any = await getRes.json();
      sha = fileData.sha;
    }

    // 2. Préparer le nouveau contenu nettoyé
    const cleanHistory = JSON.stringify({ used_topics: [] }, null, 2);
    const encodedContent = Buffer.from(cleanHistory).toString("base64");

    // 3. Mettre à jour le fichier via l'API REST
    const putUrl = `https://api.github.com/repos/${CONFIG.repoOwner}/${CONFIG.repoName}/contents/${filePath}`;
    const putRes = await fetch(putUrl, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "chore(bot): réinitialisation des thèmes enregistrés [history.json]",
        content: encodedContent,
        branch: CONFIG.defaultBranch,
        ...(sha ? { sha } : {}),
      }),
    });

    if (putRes.ok) {
      return { success: true, message: " La mémoire des thèmes a été réinitialisée avec succès !" };
    } else {
      const errText = await putRes.text();
      return { success: false, message: `Échec de la mise à jour GitHub : HTTP ${putRes.status} (${errText.slice(0, 80)})` };
    }
  } catch (err: any) {
    return { success: false, message: `Erreur réseau/API : ${err.message}` };
  }
                             }
