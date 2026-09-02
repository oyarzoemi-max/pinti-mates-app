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
  if (!response.ok) throw new Error("No se pudo descargar imagen del producto");

  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const mimeType = response.headers.get("content-type") || "image/jpeg";

  return {
    inline_data: {
      mime_type: mimeType,
      data: base64
    }
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
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
      const { targetDataUrl, candidates = [] } = req.body;

      if (!targetDataUrl) {
        return res.status(400).json({ error: "Falta la foto a comparar" });
      }

      parts.push({
        text:
          "Esta es la foto del producto que se quiere vender. " +
          "Comparala visualmente con los productos del inventario. " +
          "Prestá atención a forma, color, cuero, virola, base, patas, detalles y diseño."
      });

      parts.push(asGeminiImage(targetDataUrl));

      parts.push({
        text: "Estos son los productos candidatos del inventario:"
      });

      for (const product of candidates.slice(0, 5)) {
        if (!product.foto) continue;

        parts.push({
          text: `ID: ${product.id} | Nombre: ${product.nombre}`
        });

        const imagen = await fetchImageAsBase64(product.foto);
        if (imagen) parts.push(imagen);
      }

      parts.push({
        text:
          'Respondé únicamente JSON válido, sin markdown. ' +
          'Si encontrás una coincidencia clara: {"productId":"ID"} ' +
          'Si ninguno coincide suficientemente: {"productId":null}'
      });
    } else if (action === "suggest") {
      const { dataUrl } = req.body;

      if (!dataUrl) {
        return res.status(400).json({ error: "Falta la imagen" });
      }

      parts.push(asGeminiImage(dataUrl));

      parts.push({
        text:
          'Identificá brevemente este producto de mate. ' +
          'Respondé únicamente JSON válido en español: ' +
          '{"nombre":"nombre corto y claro"}'
      });
    } else {
      return res.status(400).json({ error: "Acción inválida" });
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
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
            temperature: 0.1,
            maxOutputTokens: 200
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini error:", data);
      return res.status(500).json({
        error: "Gemini no pudo analizar la imagen"
      });
    }

    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("")
        .replace(/```json|```/g, "")
        .trim() || "";

    if (!text) {
      throw new Error("Gemini devolvió una respuesta vacía");
    }

    const parsed = JSON.parse(text);

    return res.status(200).json(parsed);
  } catch (error) {
    console.error("Error vision:", error);

    return res.status(500).json({
      error: "No se pudo procesar la imagen"
    });
  }
}
