import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [],
      manifest: {
        name: "Pinti Mates · Negocio",
        short_name: "Pinti Mates",
        description: "Inventario, ventas, precios y estadísticas de Pinti Mates",
        theme_color: "#8B5A35",
        background_color: "#FAF3E8",
        display: "standalone",
        start_url: "/",
        scope: "/",
        orientation: "any",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        navigateFallback: "/index.html"
      }
    })
  ]
});
