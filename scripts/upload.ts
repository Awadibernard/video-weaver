/**
 * upload.ts — ÉTAPE 3 du pipeline.
 *
 * Héberge temporairement la vidéo rendue sur Litterbox puis crée le post
 * TikTok via l'API GraphQL de Buffer.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** Limite dure de Litterbox : 1 Go. */
const LITTERBOX_MAX_BYTES = 1_000 * 1024 * 1024;
/** Capacité minimale exigée par le pipeline (assertion de compatibilité). */
const REQUIRED_MIN_CAPACITY_BYTES = 500 * 1024 * 1024;

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);

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

  // --- FILET DE SÉCURITÉ : contrôle du poids avant tout transfert réseau ---
  const stats = fs.statSync(videoPath);
  console.log(`📦 Poids de la vidéo : ${mb(stats.size)} Mo`);

  if (stats.size === 0) throw new Error("❌ Vidéo vide (0 octet) — le rendu a probablement échoué.");
  if (LITTERBOX_MAX_BYTES < REQUIRED_MIN_CAPACITY_BYTES) {
    throw new Error("❌ L'hébergeur configuré n'atteint pas la capacité minimale requise de 500 Mo.");
  }
  if (stats.size > LITTERBOX_MAX_BYTES) {
    throw new Error(
      `❌ Vidéo trop lourde : ${mb(stats.size)} Mo > limite Litterbox de ${mb(LITTERBOX_MAX_BYTES)} Mo (1 Go).`,
    );
  }
  console.log(`✅ Poids validé (limite hébergeur : 1 Go, minimum requis : 500 Mo).`);

  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));

  // --- Assemblage structuré : Titre + Description + Hashtags ---
  const titlePart = metadata.topic ? `${metadata.topic.trim()}\n\n` : "";
  const descPart = metadata.description ? `${metadata.description.trim()}\n\n` : "";
  const hashtagPart = Array.isArray(metadata.hashtags) ? metadata.hashtags.join(" ") : "";

  const captionText = `${titlePart}${descPart}${hashtagPart}`.trim();

  console.log("📝 Légende TikTok générée :");
  console.log("----------------------------------------");
  console.log(captionText);
  console.log("----------------------------------------");

  console.log("📤 Génération d'une URL publique via Litterbox...");
  const fileBuffer = fs.readFileSync(videoPath);
  const formData = new FormData();
  formData.append("reqtype", "fileupload");
  formData.append("time", "72h"); // rétention maximale autorisée par Litterbox
  formData.append("fileToUpload", new Blob([fileBuffer]), "video.mp4");

  const uploadResponse = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
    method: "POST",
    body: formData,
  });
  if (!uploadResponse.ok) throw new Error("❌ Échec de l'hébergement temporaire de la vidéo.");

  const publicVideoUrl = (await uploadResponse.text()).trim();
  if (!publicVideoUrl.startsWith("http")) {
    throw new Error(`❌ Réponse Litterbox inattendue : ${publicVideoUrl.slice(0, 200)}`);
  }
  console.log(`🔗 URL vidéo directe : ${publicVideoUrl}`);

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