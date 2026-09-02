# Pinti Mates · Negocio PWA

Aplicación React/Vite preparada como PWA instalable en Android, iPhone y iPad.

## Desarrollo
npm install
npm run dev

## Producción
npm run build

## IA por fotografía
En Vercel configurar la variable de entorno `ANTHROPIC_API_KEY`. La clave queda del lado del servidor y nunca expuesta en el navegador.

## Instalación en móvil
- Android: abrir en Chrome > menú > Agregar a pantalla de inicio / Instalar app.
- iPhone/iPad: abrir en Safari > Compartir > Añadir a pantalla de inicio.

Los datos se guardan en IndexedDB mediante LocalForage, compatible con navegadores móviles modernos.
