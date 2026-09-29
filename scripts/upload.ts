/**
 * upload.ts — ÉTAPE 3 du pipeline.
 *
 * Hébergement automatique multi-hôtes (priorité à GitHub Releases)
 * avec retry intelligent vers Buffer GraphQL API et fallback Telegram sécurisé.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const MAX_UPLOAD_BYTES = 1_000 * 1024 * 1024; // 1 Go
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- 1. FONCTIONS D'HÉBERGEMENT (GITHUB RELEASES + PROVIDERS SECONDAIRES) ---

/**
 * Hébergeur N°1 : GitHub Releases (Instantané, CDN mondial, zéro blocage Buffer)
 */
async function uploadGitHubRelease(fileBuffer: Buffer): Promise<string> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_PAT;
  const repo = process.env.GITHUB_REPOSITORY;

  if (!token || !repo) {
    throw new Error("GITHUB_TOKEN / GH_PAT ou GITHUB_REPOSITORY non défini dans l'environnement.");
  }

  const [owner, repoName] = repo.split("/");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // 1. Obtenir ou créer la Release 'latest'
  let release: any;
  const getReleaseRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/releases/tags/latest`, { headers });

  if (getReleaseRes.ok) {
    release = await getReleaseRes.json();
  } else if (getReleaseRes.status === 404) {
    const createRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/releases`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: "latest",
        name: "Dernière Vidéo Générée",
        body: "Release automatique pour publication Buffer",
        draft: false,
        prerelease: false,
      }),
    });
    if (!createRes.ok) throw new Error(`Création Release GitHub échouée : HTTP ${createRes.status}`);
    release = await createRes.json();
  } else {
    throw new Error(`Recherche Release GitHub échouée : HTTP ${getReleaseRes.status}`);
  }

  // 2. Supprimer l'ancien fichier 'quiz.mp4' s'il existe déjà dans la Release
  if (Array.isArray(release.assets)) {
    const oldAsset = release.assets.find((a: any) => a.name === "quiz.mp4");
    if (oldAsset) {
      await fetch(`https://api.github.com/repos/${owner}/${repoName}/releases/assets/${oldAsset.id}`, {
        method: "DELETE",
        headers,
      });
    }
  }

  // 3. Televerser le nouveau fichier MP4
  const uploadUrlBase = release.upload_url.split("{")[0];
  const uploadRes = await fetch(`${uploadUrlBase}?name=quiz.mp4`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "video/mp4",
    },
    body: fileBuffer,
    signal: AbortSignal.timeout(180_000),
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`Upload asset GitHub Release : HTTP ${uploadRes.status} - ${errText.slice(0, 100)}`);
  }

  const uploadedAsset: any = await uploadRes.json();
  return uploadedAsset.browser_download_url;
}

async function uploadTmpfiles(fileBuffer: Buffer): Promise<string> {
  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer]), "quiz.mp4");

  const res = await fetch("https://tmpfiles.org/api/v1/upload", {
    method: "POST",
    headers: { "User-Agent": USER_AGENT },
    body: formData,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json: any = await res.json();
  if (json.status === "success" && json.data?.url) {
    return json.data.url.replace("tmpfiles.org/", "tmpfiles.org/dl/");
  }
  throw new Error("Réponse JSON invalide de Tmpfiles");
}

async function uploadLitterbox(fileBuffer: Buffer): Promise<string> {
  const formData = new FormData();
  formData.append("reqtype", "fileupload");
  formData.append("time", "72h");
  formData.append("fileToUpload", new Blob([fileBuffer]), "quiz.mp4");

  const res = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
    method: "POST",
    headers: { "User-Agent": USER_AGENT },
    body: formData,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = (await res.text()).trim();
  if (!url.startsWith("http")) throw new Error(`Réponse inattendue : ${url.slice(0, 50)}`);
  return url;
}

async function uploadCatbox(fileBuffer: Buffer): Promise<string> {
  const formData = new FormData();
  formData.append("reqtype", "fileupload");
  formData.append("fileToUpload", new Blob([fileBuffer]), "quiz.mp4");

  const res = await fetch("https://catbox.moe/user/api.php", {
    method: "POST",
    headers: { "User-Agent": USER_AGENT },
    body: formData,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = (await res.text()).trim();
  if (!url.startsWith("http")) throw new Error(`Réponse inattendue : ${url.slice(0, 50)}`);
  return url;
}

async function uploadTransferSh(fileBuffer: Buffer): Promise<string> {
  const res = await fetch("https://transfer.sh/quiz.mp4", {
    method: "PUT",
    headers: { "Max-Days": "1", "User-Agent": USER_AGENT },
    body: fileBuffer,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = (await res.text()).trim();
  if (!url.startsWith("http")) throw new Error(`Réponse inattendue : ${url.slice(0, 50)}`);
  return url;
}

async function uploadPixeldrain(fileBuffer: Buffer): Promise<string> {
  const res = await fetch("https://pixeldrain.com/api/file", {
    method: "POST",
    body: new Blob([fileBuffer]),
    headers: { "Content-Type": "video/mp4", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json: any = await res.json();
  if (!json.success) throw new Error("Pixeldrain a refusé le fichier.");
  return `https://pixeldrain.com/api/file/${json.id}`;
}

async function upload0x0(fileBuffer: Buffer): Promise<string> {
  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer]), "quiz.mp4");

  const res = await fetch("https://0x0.st", {
    method: "POST",
    headers: { "User-Agent": USER_AGENT },
    body: formData,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = (await res.text()).trim();
  if (!url.startsWith("http")) throw new Error(`Réponse inattendue : ${url.slice(0, 50)}`);
  return url;
}

const PROVIDERS = [
  { name: "GitHub Releases (Recommandé)", fn: uploadGitHubRelease },
  { name: "Tmpfiles.org", fn: uploadTmpfiles },
  { name: "Litterbox", fn: uploadLitterbox },
  { name: "Catbox.moe", fn: uploadCatbox },
  { name: "Transfer.sh", fn: uploadTransferSh },
  { name: "Pixeldrain", fn: uploadPixeldrain },
  { name: "0x0.st", fn: upload0x0 },
];

// --- 2. ENVOI DE POST VERS BUFFER GRAPHQL ---

async function postToBuffer(accessToken: string, profileId: string, captionText: string, videoUrl: string) {
  const query = `
    mutation CreatePost(
      $channelId: ChannelId!,
      $text: String!,
      $mode: ShareMode!,
      $schedulingType: SchedulingType!,
      $videoUrl: String!
    ) {
      createPost(
        input: {
          channelId: $channelId,
          text: $text,
          mode: $mode,
          schedulingType: $schedulingType,
          assets: { video: { url: $videoUrl } }
        }
      ) {
        __typename
        ... on PostActionSuccess { post { id status } }
        ... on InvalidInputError { message }
      }
    }
  `;

  const res = await fetch("https://api.buffer.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      query,
      variables: {
        channelId: profileId,
        text: captionText,
        mode: "shareNow",
        schedulingType: "automatic",
        videoUrl,
      },
    }),
  });

  const bufferResult: any = await res.json();
  const payload = bufferResult.data?.createPost;

  if (res.ok && payload?.__typename === "PostActionSuccess") {
    return { success: true, post: payload.post };
  }

  const errorMsg = payload?.message || JSON.stringify(bufferResult);
  return { success: false, error: errorMsg };
}

// --- 3. RECOURS ULTIME TELEGRAM (ENVOI DIRECT OU AVEC LINK SI > 49 MO) ---

async function fallbackSendTelegram(videoPath: string, captionText: string, errorsLog: string[], lastReleaseUrl?: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn("⚠️ Telegram non configuré (TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID absent). Impossible d'envoyer le fichier de secours.");
    return;
  }

  console.log("\n📱 Échec de la publication Buffer. Transmission de secours sur Telegram...");

  try {
    const stats = fs.statSync(videoPath);
    const isTooBigForDirectUpload = stats.size > 49 * 1024 * 1024; // > 49 Mo (Limite de l'API Bot Telegram)
    const summary = errorsLog.slice(-6).map((e) => `• ${e}`).join("\n");

    if (isTooBigForDirectUpload) {
      console.log(`ℹ️ La vidéo fait ${mb(stats.size)} Mo (> 49 Mo). Envoi via message texte avec lien de téléchargement direct pour éviter le rejet HTTP 413.`);
      
      const linkText = lastReleaseUrl ? `\n\n📥 **Lien de téléchargement direct HD :**\n${lastReleaseUrl}` : "";
      const telegramCaption = `🚨 **ÉCHEC PUBLICATION AUTOMATIQUE (BUFFER)**\n\n**Rapport d'erreurs :**\n${summary}${linkText}\n\n📝 **Légende pré-rédigée :**\n${captionText}\n\n👉 *Téléchargez la vidéo depuis le lien ci-dessus et publiez-la manuellement.*`;

      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: telegramCaption,
          parse_mode: "Markdown",
        }),
      });

      if (res.ok) {
        console.log("✅ Message de secours envoyé avec succès sur Telegram !");
      } else {
        console.error("❌ Échec envoi message Telegram :", await res.text());
      }
    } else {
      // Envoi direct de la vidéo si <= 49 Mo
      const videoBuffer = fs.readFileSync(videoPath);
      const telegramCaption = `🚨 **ÉCHEC PUBLICATION AUTOMATIQUE**\n\n**Rapport d'erreurs :**\n${summary}\n\n📝 **Légende pré-rédigée :**\n${captionText}\n\n👉 *Téléchargez ce fichier et publiez-le manuellement.*`;

      const formData = new FormData();
      formData.append("chat_id", chatId);
      formData.append("caption", telegramCaption.slice(0, 1024));
      formData.append("video", new Blob([videoBuffer]), "quiz.mp4");

      const res = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        console.log("✅ Vidéo MP4 transmise avec succès sur Telegram !");
      } else {
        console.error("❌ Échec envoi vidéo Telegram :", await res.text());
      }
    }
  } catch (err: any) {
    console.error("❌ Erreur lors de l'envoi secours vers Telegram :", err.message);
  }
}

// --- 4. ORCHESTRATEUR PRINCIPAL ---

export async function uploadToBufferGraphQL(): Promise<void> {
  console.log("🚀 Étape 3/3 — Publication automatisée TikTok via Buffer...");

  const accessToken = process.env.BUFFER_ACCESS_TOKEN;
  const profileId = process.env.BUFFER_TIKTOK_PROFILE_ID;

  if (!accessToken || !profileId) {
    throw new Error("❌ BUFFER_ACCESS_TOKEN ou BUFFER_TIKTOK_PROFILE_ID manquant dans l'environnement.");
  }

  const metadataPath = path.join(ROOT, "input/metadata.json");
  const videoPath = path.join(ROOT, "out/quiz.mp4");

  if (!fs.existsSync(videoPath)) throw new Error(`❌ Le fichier vidéo n'existe pas : ${videoPath}`);
  if (!fs.existsSync(metadataPath)) throw new Error(`❌ Metadata introuvable : ${metadataPath}`);

  const stats = fs.statSync(videoPath);
  console.log(`📦 Poids de la vidéo : ${mb(stats.size)} Mo`);

  if (stats.size === 0) throw new Error("❌ Vidéo vide (0 octet).");
  if (stats.size > MAX_UPLOAD_BYTES) throw new Error(`❌ Vidéo trop lourde (${mb(stats.size)} Mo > 1 Go).`);

  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const titlePart = metadata.topic ? `${metadata.topic.trim()}\n\n` : "";
  const descPart = metadata.description ? `${metadata.description.trim()}\n\n` : "";
  const hashtagPart = Array.isArray(metadata.hashtags) ? metadata.hashtags.join(" ") : "";
  const captionText = `${titlePart}${descPart}${hashtagPart}`.trim();

  const MAX_ROUNDS = 2;
  const RETRIES_PER_URL = 2;
  const RETRY_WAIT_MS = 30_000;

  const errorsLog: string[] = [];
  let lastReleaseUrl = "";

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n🔄 --- TOUR D'HÉBERGEMENT ${round}/${MAX_ROUNDS} ---`);

    for (const provider of PROVIDERS) {
      console.log(`\n📡 Tentative avec ${provider.name}...`);
      let videoUrl = "";

      try {
        videoUrl = await provider.fn(fs.readFileSync(videoPath));
        console.log(`   ✅ URL générée par ${provider.name} : ${videoUrl}`);
        if (provider.name.includes("GitHub")) {
          lastReleaseUrl = videoUrl;
        }
      } catch (e: any) {
        const msg = `Hôte ${provider.name} indisponible : ${e.message}`;
        console.warn(`   ⚠️ ${msg}`);
        errorsLog.push(`[Tour ${round}] ${msg}`);
        continue;
      }

      for (let attempt = 1; attempt <= RETRIES_PER_URL; attempt++) {
        console.log(`   📲 Envoi à Buffer (Tentative ${attempt}/${RETRIES_PER_URL})...`);
        
        const bResult = await postToBuffer(accessToken, profileId, captionText, videoUrl);

        if (bResult.success) {
          console.log("\n🎉 VIDÉO ENVOYÉE AVEC SUCCÈS À BUFFER !");
          console.log("Détails du post :", JSON.stringify(bResult.post, null, 2));
          return;
        }

        const bErr = `Buffer a rejeté l'URL de ${provider.name} (T${attempt}) : ${bResult.error}`;
        console.warn(`   ⚠️ ${bErr}`);
        errorsLog.push(`[Tour ${round}] ${bErr}`);

        if (attempt < RETRIES_PER_URL) {
          console.log(`   ⏳ Pause de ${RETRY_WAIT_MS / 1000}s avant de réessayer Buffer...`);
          await delay(RETRY_WAIT_MS);
        }
      }

      console.warn(`   ❌ Passage à l'hébergeur suivant suite aux réjections de Buffer.`);
    }
  }

  // Recours ultime Telegram
  await fallbackSendTelegram(videoPath, captionText, errorsLog, lastReleaseUrl);
  throw new Error("❌ Tous les serveurs d'hébergement et retries Buffer ont échoué. La vidéo a été transmise sur Telegram.");
}

if (require.main === module) {
  uploadToBufferGraphQL().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
