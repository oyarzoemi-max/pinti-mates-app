// api/vision.js
//
// NUEVO en esta versión: verificación de autenticación.
//
// Antes, cualquiera que conociera la URL de este endpoint podía llamarlo
// directamente desde afuera de la app, sin pasar por el login, gastando la
// cuota de la API de Gemini sin control. Ahora el handler exige un token de
// sesión válido de Supabase (Authorization: Bearer <token>) antes de hacer
// cualquier llamada a Gemini. Si no viene un token válido, responde 401 y
// no gasta ni un token de Gemini.
//
// Usa las variables de entorno que YA tenés cargadas en Vercel:
// VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY (las mismas que usa el
// frontend). No hace falta agregar variables nuevas — Vercel expone todas
// las Environment Variables del proyecto a las funciones serverless,
// independientemente del prefijo VITE_ (ese prefijo solo le importa a Vite
// para decidir qué variables inyecta en el bundle del navegador).

import { createClient } from "@supabase/supabase-js";

const MAX_CANDIDATES_PER_CALL = 10;

const supabaseAuth = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return null;
  }

  try {
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data?.user) {
      return null;
    }
    return data.user;
  } catch (error) {
    console.error("Error validando sesión:", error);
    return null;
  }
}

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

  if (!process.env.VITE_SUPABASE_URL || !process.env.VITE_SUPABASE_ANON_KEY) {
    return res.status(503).json({ error: "Falta configurar VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY" });
  }

  // --- Verificación de sesión: corta acá si no hay un usuario logueado ---
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ error: "No autorizado. Iniciá sesión para usar esta función." });
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
