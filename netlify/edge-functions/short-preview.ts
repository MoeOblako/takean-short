import { Context } from "@netlify/edge-functions";

const FIREBASE_PROJECT_ID = "takean";
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

const BOT_REGEX = /telegrambot|twitterbot|facebookexternalhit|whatsapp|discordbot|vkshare|linkedinbot|yandexbot|googlebot|bingbot|applebot|slackbot|skypeuripreview/i;

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  const userAgent = request.headers.get("user-agent") || "";

  // Пропускаем статические файлы и служебные расширения
  if (url.pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|json|woff|woff2|ttf)$/i)) {
    return context.next();
  }

  // Извлекаем shortId из query ?id=6 или из пути /6
  let shortId = url.searchParams.get("id");
  if (!shortId) {
    const cleanPath = url.pathname.replace(/^\/+|\/+$/g, ""); // Убираем слэши в начале и конце
    if (cleanPath && !isNaN(Number(cleanPath))) {
      shortId = cleanPath;
    }
  }

  const isBot = BOT_REGEX.test(userAgent);

  // Если это не бот или нет shortId, отдаем обычный index.html для редиректа юзера
  if (!shortId || !isBot) {
    return context.next();
  }

  try {
    let fields: Record<string, any> | null = null;

    // 1. Поиск в Firestore по shortId (как строка, например "6")
    fields = await searchFirestore("shortId", shortId, "stringValue");

    // 2. Если не найдено — поиск по shortId (как число, например 6)
    if (!fields && !isNaN(Number(shortId))) {
      fields = await searchFirestore("shortId", parseInt(shortId, 10), "integerValue");
    }

    // 3. Если не найдено — поиск по order (как число)
    if (!fields && !isNaN(Number(shortId))) {
      fields = await searchFirestore("order", parseInt(shortId, 10), "integerValue");
    }

    if (!fields) {
      return context.next();
    }

    // 4. Заголовок
    const title = fields.title?.stringValue || "Takean";

    // 5. Текст поста
    const rawContent = 
      fields.content?.stringValue || 
      fields.text?.stringValue || 
      fields.description?.stringValue || 
      fields.body?.stringValue || 
      "";

    // 6. Извлечение изображения
    let imageUrl = "";

    if (rawContent.includes("[img]")) {
      const match = rawContent.match(/\[img\]\s*(.*?)\s*\[\/img\]/i);
      if (match && match[1]) imageUrl = match[1];
    }

    if (!imageUrl && fields.images?.arrayValue?.values?.length > 0) {
      const firstImg = fields.images.arrayValue.values[0];
      imageUrl = firstImg.stringValue || firstImg.mapValue?.fields?.url?.stringValue || "";
    }

    if (!imageUrl) {
      imageUrl = 
        fields.coverURL?.stringValue || 
        fields.cover?.stringValue || 
        fields.photoURL?.stringValue || 
        fields.imageUrl?.stringValue || 
        fields.image?.stringValue || 
        "";
    }

    if (imageUrl) {
      if (imageUrl.startsWith("//")) imageUrl = "https:" + imageUrl;
      else if (!imageUrl.startsWith("http")) imageUrl = "https://" + imageUrl;
    } else {
      imageUrl = "https://takean.cl.is/og-image.png";
    }

    // 7. Очистка текста от тегов
    let cleanDescription = rawContent
      .replace(/\[img\].*?\[\/img\]/gi, "")
      .replace(/\[.*?\]/g, "")
      .replace(/!\[.*?\]\(.*?\)/g, "")
      .replace(/#+/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleanDescription) {
      cleanDescription = "Смотрите подробнее на Takean";
    } else if (cleanDescription.length > 180) {
      cleanDescription = cleanDescription.substring(0, 177) + "...";
    }

    // 8. Ответ с метатегами для социальной сети
    const html = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>${escapeXml(title)}</title>
    <meta name="description" content="${escapeXml(cleanDescription)}">

    <!-- Open Graph -->
    <meta property="og:site_name" content="Takean">
    <meta property="og:type" content="article">
    <meta property="og:title" content="${escapeXml(title)}">
    <meta property="og:description" content="${escapeXml(cleanDescription)}">
    <meta property="og:image" content="${imageUrl}">
    <meta property="og:image:secure_url" content="${imageUrl}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:url" content="${url.href}">

    <!-- Twitter / Telegram Large Card -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeXml(title)}">
    <meta name="twitter:description" content="${escapeXml(cleanDescription)}">
    <meta name="twitter:image" content="${imageUrl}">
</head>
<body>
    <h1>${escapeXml(title)}</h1>
    <p>${escapeXml(cleanDescription)}</p>
    <img src="${imageUrl}" alt="Cover">
</body>
</html>`;

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=300"
      }
    });

  } catch (err) {
    console.error("Short Preview Error:", err);
    return context.next();
  }
};

async function searchFirestore(fieldName: string, value: string | number, valueType: string): Promise<Record<string, any> | null> {
  try {
    const queryUrl = `${FIRESTORE_URL}:runQuery`;
    const queryBody = {
      structuredQuery: {
        from: [{ collectionId: "posts" }],
        where: {
          fieldFilter: {
            field: { fieldPath: fieldName },
            op: "EQUAL",
            value: { [valueType]: value }
          }
        },
        limit: 1
      }
    };

    const res = await fetch(queryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(queryBody)
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data[0]?.document?.fields) {
        return data[0].document.fields;
      }
    }
  } catch (e) {
    console.error(`Firestore query error for ${fieldName}:`, e);
  }
  return null;
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export const config = {
  path: ["/*"],
};
