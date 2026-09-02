function asGeminiImage(dataUrl) {
  const [meta, data] = dataUrl.split(",");
  const mimeType = meta.match(/data:(.*);base64/)?.[1] || "image/jpeg";

  return {
    inline_data: {
      mime_type: mimeType,
      data
    }
  };
}

async function fetchImageAsBase64(url) {
  if (!url) return null;

  if (url.startsWith("data:")) {
    return asGeminiImage(url);
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("No se pudo descargar imagen del producto");
  }

  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const mimeType =
    response.headers.get("content-type") || "image/jpeg";

  return {
    inline_data: {
      mime_type: mimeType,
      data: base64
    }
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(parts) {
  const models = [
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash"
];

  let lastError = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 1; attempt++) {
      try {
        console.log(
          `Probando Gemini modelo=${model} intento=${attempt}`
        );

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": process.env.GEMINI_API_KEY
            },
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts
                }
              ],
              generationConfig: {
                temperature: 0,
                maxOutputTokens: 300,
                responseMimeType: "application/json"
              }
            })
          }
        );

        const rawText = await response.text();

        let data = {};

        try {
          data = rawText ? JSON.parse(rawText) : {};
        } catch {
          data = {};
        }

        if (response.ok) {
          return data;
        }

        const status = response.status;

        console.error(
          `Gemini ${model} intento ${attempt} error ${status}:`,
          rawText
        );

        lastError = new Error(
          `Gemini ${model} respondió ${status}`
        );

        if (status === 429 || status === 500 || status === 503) {
          await wait(attempt * 1200);
          continue;
        }

        break;
      } catch (error) {
        console.error(
          `Error llamando a ${model}:`,
          error
        );

        lastError = error;

        await wait(attempt * 1000);
      }
    }
  }

  throw lastError || new Error("Todos los modelos Gemini fallaron");
}

function extractGeminiJson(data) {
  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim() || "";

  if (!text) {
    throw new Error("Gemini devolvió una respuesta vacía");
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    console.error("Respuesta Gemini no JSON:", text);
    throw new Error("Gemini devolvió JSON inválido");
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método no permitido"
    });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({
      error: "Falta configurar GEMINI_API_KEY"
    });
  }

  try {
    const { action } = req.body || {};
    const parts = [];

    if (action === "match") {
      const {
        targetDataUrl,
        candidates = []
      } = req.body;

      if (!targetDataUrl) {
        return res.status(400).json({
          error: "Falta la foto a comparar"
        });
      }

      parts.push({
        text:
          "OBJETIVO: identificar cuál producto del inventario es el mismo objeto de la primera fotografía. " +
          "La primera imagen es el producto fotografiado para vender. " +
          "Después recibirás imágenes de productos del inventario, cada una precedida por su ID y nombre. " +
          "Compará visualmente el objeto, no solamente el fondo o el ángulo. " +
          "Prestá mucha atención a forma del mate, color del cuero, textura, virola, base, patas, bolitas, grabados, costuras y detalles únicos. " +
          "Si una imagen es claramente el mismo producto aunque esté tomada desde otro ángulo, considerala coincidencia."
      });

      parts.push({
        text: "FOTO A IDENTIFICAR:"
      });

      parts.push(
        asGeminiImage(targetDataUrl)
      );

      parts.push({
        text: "PRODUCTOS DEL INVENTARIO:"
      });

      let cantidadImagenes = 0;

      for (const product of candidates.slice(0, 5)) {
        if (!product.foto) continue;

        parts.push({
          text:
            `PRODUCTO ID=${product.id} NOMBRE="${product.nombre}"`
        });

        try {
          const imagen =
            await fetchImageAsBase64(product.foto);

          if (imagen) {
            parts.push(imagen);
            cantidadImagenes++;
          }
        } catch (error) {
          console.error(
            `No se pudo cargar foto de ${product.nombre}:`,
            error
          );
        }
      }

      if (cantidadImagenes === 0) {
        return res.status(200).json({
          productId: null
        });
      }

      parts.push({
  text:
    'Respondé EXCLUSIVAMENTE con JSON válido. ' +
    'Formato obligatorio si hay coincidencia: {"productId":"ID","confidence":95}. ' +
    'Si ninguna coincide con suficiente seguridad: {"productId":null,"confidence":0}. ' +
    "confidence debe ser un número entero de 0 a 100. " +
    "NO elijas un producto solamente porque sea parecido. " +
    "Debe coincidir el mismo objeto considerando simultáneamente forma, cuero, color, virola, base, patas, bolitas, grabados y detalles únicos. " +
    "Si existen diferencias importantes, devolvé productId null. " +
    "Solo asigná confidence 90 o superior cuando estés muy seguro de que es exactamente el mismo producto. " +
    "No agregues explicaciones."
});
  }

    else if (action === "suggest") {
      const { dataUrl } = req.body;

      if (!dataUrl) {
        return res.status(400).json({
          error: "Falta la imagen"
        });
      }

      parts.push(
        asGeminiImage(dataUrl)
      );

      parts.push({
        text:
          "Identificá brevemente este producto matero. " +
          'Respondé únicamente JSON válido: {"nombre":"nombre corto y claro"}'
      });
    }

    else {
      return res.status(400).json({
        error: "Acción inválida"
      });
    }

    const data = await callGemini(parts);
    const parsed = extractGeminiJson(data);

if (
  action === "match" &&
  parsed.productId &&
  Number(parsed.confidence || 0) < 90
) {
  return res.status(200).json({
    productId: null,
    confidence: Number(parsed.confidence || 0)
  });
}

return res.status(200).json(parsed);
  } catch (error) {
    console.error("Error vision final:", error);

    return res.status(503).json({
      error:
        "El reconocimiento por foto está temporalmente ocupado. Intentá nuevamente en unos segundos."
    });
  }
}
