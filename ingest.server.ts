import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { CATEGORY_SLUGS, isCategorySlug } from "./categories";
import { NEWS_SOURCES } from "./news-sources";
import { buildSlug, pickCandidates, type FeedItem } from "./ingest-utils";
import { fetchFeed, fetchOgImage } from "./rss.server";

const JOB_ID = "news-ingest";
const LOCK_SECONDS = 300;
const RUN_INTERVAL_MS = 3 * 3600 * 1000;

export type Written = {
  relevant: boolean;
  category: string;
  title: string;
  summary: string;
  body: string[];
  tags: string[];
};

type ItemOutcome =
  | { status: "published"; slug: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string; stop?: "credits" | "denied" | "rate_limit" };

export type IngestResult = {
  ok: boolean;
  message: string;
  outcomes?: Array<{ link: string } & ItemOutcome>;
};

const INSTRUCTIONS = `Você é o editor-chefe e redator sênior do GeekManchete, o principal portal brasileiro de notícias sobre o universo geek, games, cinema, séries, animes, mangás, HQs e tecnologia.

Sua missão é transformar a notícia original recebida em uma matéria JORNALÍSTICA COMPLETA, BEM DESENVOLVIDA E APROFUNDADA em português do Brasil, voltada para fãs exigentes.

Diretrizes de redação:
- Manchete (title): Crie um título forte, chamativo, informativo e contextualizado (entre 60 e 110 caracteres). Não seja apelativo nem faça clickbait vazio, mas desperte curiosidade imediata.
- Linha Fina (summary): Um parágrafo conciso de 2 a 3 frases explicando o acontecimento principal e por que ele importa.
- Corpo da matéria (body):
  * Mínimo de 5 a 8 parágrafos longos, bem estruturados e fluidos.
  * O primeiro parágrafo deve ser o lide jornalístico (quem, o quê, quando, onde e por quê).
  * Inclua contextualização histórica ou de mercado (jogos anteriores da franquia, histórico do estúdio, temporada passada do anime, impacto na cultura pop, etc.).
  * Intercale de 1 a 3 subtítulos usando o formato '## Título do Tópico' dentro do array de parágrafos para organizar a leitura.
  * Use linguagem nerd/geek fluida, natural e técnica quando couber, sem jargões forçados.
- Veracidade: Apenas use fatos do texto original. Não invente declarações nem datas. Se algo não estiver confirmado na fonte, contextualize como especulação ou rumor.
- Não mencione "segundo o site" ou "o artigo fonte diz". O crédito oficial é exibido automaticamente no rodapé do portal.
- Categorias:
  * games (jogos, consoles, eSports, trailers)
  * animes (animes, mangás, produções japonesas)
  * quadrinhos (HQs, graphic novels, super-heróis em quadrinhos)
  * cinema (filmes, séries, streaming, Hollywood)
  * geek (tecnologia, gadgets, ciência, colecionáveis, cultura pop)
- Relevância: se não for sobre cultura geek/pop/nerd (ex: fofoca de celebridades não-nerd, reality shows, política partidária, esportes convencionais, cupons de loja), defina relevant = false.`;

/**
 * 1. Provedor Primário: Google Gemini API (usa GEMINI_API_KEY)
 */
async function rewriteWithGemini(item: FeedItem, apiKey: string): Promise<Written> {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const prompt = `Categoria sugerida pela fonte: ${item.hint}\nTítulo original: ${item.title}\n\nTexto de origem completo:\n${item.text || item.title}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    systemInstruction: {
      parts: [{ text: INSTRUCTIONS }],
    },
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 5000,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          relevant: { type: "BOOLEAN" },
          category: { type: "STRING", enum: CATEGORY_SLUGS },
          title: { type: "STRING" },
          summary: { type: "STRING" },
          body: {
            type: "ARRAY",
            items: { type: "STRING" },
          },
          tags: {
            type: "ARRAY",
            items: { type: "STRING" },
          },
        },
        required: ["relevant", "category", "title", "summary", "body", "tags"],
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API Error [${res.status}]: ${errText}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawJson) {
    throw new Error("Gemini retornou resposta sem conteúdo de texto.");
  }

  return JSON.parse(rawJson) as Written;
}

/**
 * 2. Provedor Secundário (Fallback): Cloudflare Workers AI
 */
async function rewriteWithCloudflare(
  item: FeedItem,
  accountId: string,
  apiToken: string
): Promise<Written> {
  const model = process.env.CLOUDFLARE_MODEL || "@cf/meta/llama-3.3-70b-instruct";
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

  const prompt = `Categoria sugerida: ${item.hint}
Título original: ${item.title}
Texto de origem:
${item.text || item.title}

IMPORTANTE: Responda APENAS com um objeto JSON válido, sem crases markdown ou texto adicional, seguindo exatamente este formato:
{
  "relevant": true,
  "category": "games",
  "title": "Manchete detalhada e chamativa",
  "summary": "Linha fina de 2 a 3 frases",
  "body": ["## Primeiro Subtítulo", "Parágrafo 1...", "Parágrafo 2..."],
  "tags": ["tag1", "tag2", "tag3"]
}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Cloudflare AI Error [${res.status}]: ${errText}`);
  }

  const data = (await res.json()) as { result?: { response?: string } };
  const rawText = data.result?.response;
  if (!rawText) throw new Error("Cloudflare AI retornou resposta vazia");

  const cleaned = rawText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(cleaned) as Written;
}

/**
 * Orquestrador de IA: Tenta Gemini primeiro, depois Cloudflare
 */
async function rewrite(item: FeedItem): Promise<Written> {
  const geminiKey = process.env.GEMINI_API_KEY;
  const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const cfToken = process.env.CLOUDFLARE_API_TOKEN;

  if (geminiKey) {
    try {
      return await rewriteWithGemini(item, geminiKey);
    } catch (geminiError) {
      console.warn("[ingest] Falha no Gemini, tentando Cloudflare se disponível:", geminiError);
      if (cfAccountId && cfToken) {
        return await rewriteWithCloudflare(item, cfAccountId, cfToken);
      }
      throw geminiError;
    }
  }

  if (cfAccountId && cfToken) {
    return await rewriteWithCloudflare(item, cfAccountId, cfToken);
  }

  throw new Error("Nenhuma chave de IA configurada (GEMINI_API_KEY ou CLOUDFLARE_API_TOKEN)");
}

async function markLink(url: string, status: string) {
  await supabaseAdmin.from("processed_links").upsert({ url, status }, { onConflict: "url" });
}

async function processItem(item: FeedItem): Promise<ItemOutcome> {
  try {
    const [written, ogImage] = await Promise.all([rewrite(item), fetchOgImage(item.link)]);
    
    if (!written.relevant || !written.body || written.body.length === 0) {
      await markLink(item.link, "skipped");
      return { status: "skipped", reason: "not geek" };
    }

    const category = isCategorySlug(written.category) ? written.category : "geek";
    const slug = buildSlug(written.title, item.link);

    const { error } = await supabaseAdmin.from("articles").insert({
      slug,
      title: written.title.trim(),
      summary: written.summary.trim(),
      content: written.body.map((p) => p.trim()).filter(Boolean).join("\n\n"),
      category,
      tags: (written.tags || []).slice(0, 6),
      image_url: ogImage ?? item.imageUrl,
      source_name: item.sourceName,
      source_url: item.link,
      source_published_at: item.publishedAt?.toISOString() ?? null,
    });

    if (error && error.code !== "23505") throw new Error(error.message);
    await markLink(item.link, "published");
    return { status: "published", slug };
  } catch (error) {
    const reason = String(error);
    console.error("[ingest] item failed", item.link, reason);
    return { status: "failed", reason };
  }
}

export async function readJobState() {
  const { data } = await supabaseAdmin.from("job_state").select("*").eq("id", JOB_ID).maybeSingle();
  return data;
}

export async function acquireLock(): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("acquire_job_lock", { p_id: JOB_ID, p_seconds: LOCK_SECONDS });
  if (error) throw new Error(error.message);
  return data === true;
}

/** Executa uma rodada de ingestão */
export async function runIngest(requestedLimit: number, paused: string | null): Promise<IngestResult> {
  // Se estiver com chave do Gemini própria, não limitamos artificialmente por falta de créditos
  const limit = requestedLimit;
  let result: IngestResult;

  try {
    const feeds = await Promise.allSettled(NEWS_SOURCES.map((s) => fetchFeed(s)));
    const items = feeds.flatMap((f) => (f.status === "fulfilled" ? f.value : []));
    const links = items.map((i) => i.link);
    const processed = new Set<string>();

    for (let i = 0; i < links.length; i += 100) {
      const { data } = await supabaseAdmin.from("processed_links").select("url").in("url", links.slice(i, i + 100));
      for (const row of data ?? []) processed.add(row.url);
    }

    const rotation = Math.floor(Date.now() / RUN_INTERVAL_MS);
    const candidates = pickCandidates(items, processed, limit, rotation);

    if (candidates.length === 0) {
      result = { ok: true, message: "Nada novo para publicar", outcomes: [] };
    } else {
      const outcomes = await Promise.all(candidates.map(async (c) => ({ link: c.link, ...(await processItem(c)) })));
      const published = outcomes.filter((o) => o.status === "published").length;
      
      // Se publicou com sucesso com a sua chave, despausa o job imediatamente
      if (published > 0 && paused) {
        await supabaseAdmin.from("job_state").update({ paused_reason: null }).eq("id", JOB_ID);
      }

      result = { ok: true, message: `${published} notícia(s) publicada(s)`, outcomes };
    }
  } catch (error) {
    result = { ok: false, message: String(error) };
  }

  await supabaseAdmin
    .from("job_state")
    .update({
      locked_until: null,
      last_run_at: new Date().toISOString(),
      last_result: result as never,
      updated_at: new Date().toISOString(),
    })
    .eq("id", JOB_ID);

  return result;
}
