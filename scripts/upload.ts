/**
 * upload.ts — ÉTAPE 3 du pipeline.
 *
 * Héberge temporairement la vidéo rendue avec un système de secours (fallback)
 * puis crée le post TikTok via l'API GraphQL de Buffer.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** Capacité minimale exigée par le pipeline (500 Mo). */
const REQUIRED_MIN_CAPACITY_BYTES = 500 * 1024 * 1024;
/** Limite haute de validation (1 Go). */
const MAX_UPLOAD_BYTES = 1_000 * 1024 * 1024;

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);

/**
 * Tente d'uploader la vidéo sur plusieurs services temporaires gratuits.
 * Bascule automatiquement sur le suivant si le service plante (erreur 500, timeout, etc).
 */
async function uploadWithFallback(fileBuffer: Buffer): Promise<string> {
  // 1ère tentative : Litterbox (1 Go, 72h)
  try {
    console.log("   Tentative 1 : Litterbox (Limite 1 Go, 72h)...");
    const formData = new FormData();
    formData.append("reqtype", "fileupload");
    formData.append("time", "72h");
    formData.append("fileToUpload", new Blob([fileBuffer]), "video.mp4");

    const res = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(120_000), // Timeout après 2 minutes
    });
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = (await res.text()).trim();
    if (!url.startsWith("http")) throw new Error(`Réponse inattendue : ${url.slice(0, 50)}`);
    
    console.log(`   ✅ Succès Litterbox`);
    return url;
  } catch (e) {
    console.warn(`   ⚠️ Échec Litterbox (${e instanceof Error ? e.message : "Erreur"}). Bascule sur l'alternative 1...`);
  }

  // 2ème tentative : Tmpfiles.org (1 Go, 1 à 72h)
  try {
    console.log("   Tentative 2 : Tmpfiles.org (Limite 1 Go, Max 72h)...");
    const formData = new FormData();
    formData.append("file", new Blob([fileBuffer]), "video.mp4");

    const res = await fetch("https://tmpfiles.org/api/v1/upload", {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: any = await res.json();
    
    // tmpfiles.org renvoie un lien web, on injecte /dl/ pour le lien direct de la vidéo (obligatoire pour Buffer)
    const url = json.data.url.replace("tmpfiles.org/", "tmpfiles.org/dl/");
    console.log(`   ✅ Succès Tmpfiles`);
    return url;
  } catch (e) {
    console.warn(`   ⚠️ Échec Tmpfiles (${e instanceof Error ? e.message : "Erreur"}). Bascule sur l'alternative 2...`);
  }

  // 3ème tentative (Dernier recours) : Pixeldrain (5 Go, 100 jours)
  try {
    console.log("   Tentative 3 : Pixeldrain (Limite 5 Go, Temporaire 100 jours)...");
    const res = await fetch("https://pixeldrain.com/api/file", {
      method: "POST",
      body: new Blob([fileBuffer]),
      headers: { "Content-Type": "video/mp4" },
      signal: AbortSignal.timeout(120_000),
    });
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: any = await res.json();
    if (!json.success) throw new Error("Pixeldrain a refusé le fichier.");
    
    const url = `https://pixeldrain.com/api/file/${json.id}`;
    console.log(`   ✅ Succès Pixeldrain`);
    return url;
  } catch (e) {
    throw new Error(`❌ Tous les hébergeurs temporaires ont échoué. Dernier crash : ${e instanceof Error ? e.message : "Erreur inconnue"}`);
  }
}

export async function uploadToBufferGraphQL(): Promise<void> {
  console.log("🚀 Étape 3/3 — Upload via Buffer GraphQL API...");

  const accessToken = process.env.BUFFER_ACCESS_TOKEN;
  const profileId = process.env.BUFFER_TIKTOK_PROFILE_ID;

  if (!accessToken || !profileId) {
    throw new Error("❌ BUFFER_ACCESS_TOKEN ou BUFFER_TIKTOK_PROFILE_ID manquant dans les variables d'environnement.");
  }

  const metadataPath = path.join(ROOT, "input/metadata.json");
  const videoPath = path.join(ROOT, "out/quiz.mp4");

  if (!fs.existsSync(videoPath)) throw new Error(`❌ Le fichier vidéo n'existe pas : ${videoPath}`);
  if (!fs.existsSync(metadataPath)) throw new Error(`❌ Metadata introuvable : ${metadataPath}`);

  // Contrôle du poids
  const stats = fs.statSync(videoPath);
  console.log(`📦 Poids de la vidéo : ${mb(stats.size)} Mo`);

  if (stats.size === 0) throw new Error("❌ Vidéo vide (0 octet) — le rendu a probablement échoué.");
  if (stats.size > MAX_UPLOAD_BYTES) {
    throw new Error(`❌ Vidéo trop lourde : ${mb(stats.size)} Mo > limite maximale de ${mb(MAX_UPLOAD_BYTES)} Mo (1 Go).`);
  }
  console.log(`✅ Poids validé (limite hébergeurs : minimum 1 Go).`);

  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));

  // Assemblage structuré : Titre + Description + Hashtags
  const titlePart = metadata.topic ? `${metadata.topic.trim()}\n\n` : "";
  const descPart = metadata.description ? `${metadata.description.trim()}\n\n` : "";
  const hashtagPart = Array.isArray(metadata.hashtags) ? metadata.hashtags.join(" ") : "";
  const captionText = `${titlePart}${descPart}${hashtagPart}`.trim();

  console.log("📝 Légende TikTok générée :");
  console.log("----------------------------------------");
  console.log(captionText);
  console.log("----------------------------------------");

  console.log("📤 Génération d'une URL publique temporaire...");
  const fileBuffer = fs.readFileSync(videoPath);
  
  // Appel du système de secours (fallback)
  const publicVideoUrl = await uploadWithFallback(fileBuffer);
  console.log(`🔗 URL vidéo finale utilisée par Buffer : ${publicVideoUrl}`);

  console.log("📲 Envoi de la publication à Buffer...");
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

  const bufferResponse = await fetch("https://api.buffer.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      query,
      variables: {
        channelId: profileId,
        text: captionText,
        mode: "shareNow",
        schedulingType: "automatic",
        videoUrl: publicVideoUrl,
      },
    }),
  });

  const bufferResult: any = await bufferResponse.json();
  const payload = bufferResult.data?.createPost;

  if (bufferResponse.ok && payload?.__typename === "PostActionSuccess") {
    console.log("🎉 Vidéo envoyée à Buffer ! Publication TikTok en cours...");
    console.log("Détails du post :", JSON.stringify(payload.post, null, 2));
    return;
  }

  throw new Error(`❌ Erreur de publication Buffer : ${JSON.stringify(bufferResult, null, 2)}`);
}

if (require.main === module) {
  uploadToBufferGraphQL().catch((e) => {
    console.error(e);
    process.exit(1);
  });
      }
