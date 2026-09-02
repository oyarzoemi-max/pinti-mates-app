import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function asImage(dataUrl) {
  const [meta, data] = dataUrl.split(",");
  const media_type = meta.match(/data:(.*);base64/)?.[1] || "image/jpeg";
  return { type: "image", source: { type: "base64", media_type, data } };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "Falta configurar ANTHROPIC_API_KEY" });

  try {
    const { action } = req.body || {};
    let content = [];

    if (action === "match") {
      const { targetDataUrl, candidates = [] } = req.body;
      content = [
        { type: "text", text: "Esta es la foto del producto que se quiere vender ahora:" },
        asImage(targetDataUrl),
        { type: "text", text: "Comparala con los productos candidatos del inventario:" }
      ];
      for (const p of candidates.slice(0, 12)) {
        if (!p.foto) continue;
        content.push({ type: "text", text: `ID: ${p.id} | Nombre: ${p.nombre}` });
        content.push(asImage(p.foto));
      }
      content.push({ type: "text", text: 'Respondé solamente JSON válido: {"productId":"ID coincidente"} o {"productId":null}.' });
    } else if (action === "suggest") {
      content = [
        asImage(req.body.dataUrl),
        { type: "text", text: 'Identificá el producto. Respondé solamente JSON válido: {"nombre":"nombre corto y claro en español"}.' }
      ];
    } else {
      return res.status(400).json({ error: "Acción inválida" });
    }

    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 200,
      messages: [{ role: "user", content }]
    });
    const text = msg.content.map((b) => b.type === "text" ? b.text : "").join("").replace(/```json|```/g, "").trim();
    return res.status(200).json(JSON.parse(text));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "No se pudo procesar la imagen" });
  }
}
