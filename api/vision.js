// api/vision.js
//
// Cambios respecto al original:
// 1) FICHA TÉCNICA: ahora se serializa modelo/material/color/terminación/
//    virola/guarda/base/patas/bolitas/detalles de cada candidato en el texto
//    que recibe Gemini. Antes el prompt decía "usá la ficha técnica" pero
//    nunca se la mandábamos — el modelo comparaba a ciegas, solo por imagen.
// 2) LOTES MÁS GRANDES: el límite de candidatos por llamada subió de 5 a 10
//    (constante MAX_CANDIDATES_PER_CALL), para que tenga sentido mandar
//    varios candidatos juntos y que el modelo pueda descartar por comparación
//    relativa, tal como pide el prompt ("si hay dos candidatos similares...").
//    Esto requiere subir también el BATCH_SIZE en el frontend (ver nota al
//    final del archivo).
// 3) DESCARGA EN PARALELO: las fotos de los candidatos se bajan con
//    Promise.all en vez de una por una con await secuencial.
// 4) REINTENTOS REALES: el loop de reintentos estaba fijado a 1 intento
//    (for attempt=1; attempt<=1), así que el código de backoff nunca se
//    ejecutaba. Ahora permite 2 intentos por modelo ante 429/500/503.

const MAX_CANDIDATES_PER_CALL = 10;

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
  const mimeType = response.headers.get("content-type") || "image/jpeg";

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

// Arma la línea de texto con la ficha técnica de un producto, solo con los
// campos que efectivamente tienen valor.
function fichaTecnica(product) {
  const campos = [
    product.modelo && `modelo: ${product.modelo}`,
    product.material && `material: ${product.material}`,
    product.color && `color: ${product.color}`,
    product.terminacion && `terminación: ${product.terminacion}`,
    product.virola && `virola: ${product.virola}`,
    product.guarda && `guarda lateral: ${product.guarda}`,
    product.base && `base: ${product.base}`,
    product.patas && `patas/botitas: ${product.patas}`,
    product.bolitas && `bolitas: ${product.bolitas}`,
    product.detalles && `detalles: ${product.detalles}`
  ].filter(Boolean);

  return campos.length ? campos.join(", ") : null;
}

async function callGemini(parts) {
  const models = ["gemini-3.5-flash-lite", "gemini-3.5-flash"];
  const MAX_ATTEMPTS_PER_MODEL = 2;

  let lastError = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        console.log(`Probando Gemini modelo=${model} intento=${attempt}`);

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": process.env.GEMINI_API_KEY
            },
            body: JSON.stringify({
              contents: [{ role: "user", parts }],
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
        console.error(`Gemini ${model} intento ${attempt} error ${status}:`, rawText);
        lastError = new Error(`Gemini ${model} respondió ${status}`);

        if (status === 429 || status === 500 || status === 503) {
          if (attempt < MAX_ATTEMPTS_PER_MODEL) {
            await wait(attempt * 1200);
            continue;
          }
        }
        break;
      } catch (error) {
        console.error(`Error llamando a ${model}:`, error);
        lastError = error;
        if (attempt < MAX_ATTEMPTS_PER_MODEL) {
          await wait(attempt * 1000);
        }
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
    return res.status(405).json({ error: "Método no permitido" });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: "Falta configurar GEMINI_API_KEY" });
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
          "OBJETIVO: identificar si la primera fotografía corresponde EXACTAMENTE a uno de los productos del inventario. " +
          "No buscamos productos parecidos ni de la misma categoría: buscamos el mismo modelo físico. " +
          "COMPARÁ EN ESTE ORDEN DE IMPORTANCIA: " +
          "1) VIROLA: ancho, forma, cincelado, dibujos geométricos, flores, soles, cruces, líneas y terminaciones. " +
          "2) BASE Y PATAS: tipo de base, cantidad y forma de patas, bolitas, metal y ornamentación. " +
          "3) CUERO O MATERIAL EXTERIOR: color, textura, costuras, estampado y terminación. " +
          "4) FORMA DEL MATE: cuerpo, boca, proporciones y silueta. " +
          "5) DETALLES ÚNICOS: grabados, marcas, irregularidades y cualquier elemento distintivo. " +
          "6) FICHA TÉCNICA DEL PRODUCTO: cada candidato viene acompañado de su ficha técnica (modelo, material, color, terminación, virola, guarda, base, patas, bolitas, detalles) cuando está disponible. " +
          "Estos datos complementan la fotografía y sirven para distinguir productos visualmente parecidos. " +
          "Si la ficha técnica contradice claramente lo que observás en la foto, reducí la confianza y no fuerces una coincidencia. " +
          "REGLA CRÍTICA: dos mates pueden tener el mismo color, forma y material pero ser PRODUCTOS DIFERENTES si cambia la virola, el cincelado, la base, las patas o cualquier detalle ornamental importante. " +
          "No elijas el producto por semejanza general. Compará los detalles individualmente. " +
          "Si una característica importante de la foto no coincide con el candidato, descartalo. " +
          "Si hay dos candidatos similares y no podés distinguir con seguridad cuál es el mismo producto, devolvé ninguna coincidencia. " +
          "La primera imagen es la FOTO A IDENTIFICAR. " +
          "Después recibirás las fotografías del inventario, cada una acompañada por su ID, nombre y ficha técnica."
      });

      parts.push({ text: "FOTO A IDENTIFICAR:" });
      parts.push(asGeminiImage(targetDataUrl));
      parts.push({ text: "PRODUCTOS DEL INVENTARIO:" });

      const limitados = candidates
        .filter((p) => p.foto)
        .slice(0, MAX_CANDIDATES_PER_CALL);

      // Descarga en paralelo en vez de una por una.
      const imagenesResueltas = await Promise.all(
        limitados.map(async (product) => {
          try {
            const imagen = await fetchImageAsBase64(product.foto);
            return { product, imagen };
          } catch (error) {
            console.error(`No se pudo cargar foto de ${product.nombre}:`, error);
            return { product, imagen: null };
          }
        })
      );

      let cantidadImagenes = 0;
      for (const { product, imagen } of imagenesResueltas) {
        if (!imagen) continue;

        const ficha = fichaTecnica(product);
        parts.push({
          text:
            `PRODUCTO ID=${product.id} NOMBRE="${product.nombre}"` +
            (ficha ? ` FICHA_TECNICA: ${ficha}` : "")
        });
        parts.push(imagen);
        cantidadImagenes++;
      }

      if (cantidadImagenes === 0) {
        return res.status(200).json({ productId: null, confidence: 0 });
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
          "Asigná confidence según la certeza visual real. Usá 90 a 100 únicamente cuando coincidan claramente los detalles distintivos principales. " +
          "No agregues explicaciones."
      });
    } else if (action === "suggest") {
      const { dataUrl } = req.body;
      if (!dataUrl) {
        return res.status(400).json({ error: "Falta la imagen" });
      }
      parts.push(asGeminiImage(dataUrl));
      parts.push({
        text:
          "Identificá brevemente este producto matero. " +
          'Respondé únicamente JSON válido: {"nombre":"nombre corto y claro"}'
      });
    } else {
      return res.status(400).json({ error: "Acción inválida" });
    }

    const data = await callGemini(parts);
    const parsed = extractGeminiJson(data);

    if (action === "match" && parsed.productId && Number(parsed.confidence || 0) < 90) {
      return res.status(200).json({
        productId: null,
        confidence: Number(parsed.confidence || 0)
      });
    }

    return res.status(200).json(parsed);
  } catch (error) {
    console.error("Error vision final:", error);
    return res.status(503).json({
      error: "El reconocimiento por foto está temporalmente ocupado. Intentá nuevamente en unos segundos."
    });
  }
}

/*
 * NOTA — cambio correspondiente en el FRONTEND (matchProductByPhoto):
 *
 * Subí BATCH_SIZE de 1 a un número que coincida con MAX_CANDIDATES_PER_CALL
 * de este archivo (10), así el modelo compara varios candidatos en una sola
 * llamada en vez de hacer una llamada por producto:
 *
 *   const BATCH_SIZE = 10; // antes: 1
 *
 * Con 30 productos con foto, esto baja de 30 llamadas secuenciales a 3.
 * Si en algún momento el inventario crece mucho (80-100+ productos con
 * foto), lo ideal a mediano plazo es precalcular un "embedding" de cada
 * foto al cargarla (en vez de comparar imagen contra imagen con Gemini
 * cada vez) y usar eso para preseleccionar 5-10 candidatos antes de
 * confirmar con una sola llamada de verificación — pero para el volumen
 * de un negocio como el tuyo, con BATCH_SIZE=10 alcanza y sobra.
 */
