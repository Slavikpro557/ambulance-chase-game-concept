import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Remove type="module" so the built file works when opened from file://
function removeModuleType(): Plugin {
  return {
    name: 'remove-module-type',
    enforce: 'post',
    closeBundle() {
      const htmlPath = path.resolve(__dirname, 'dist/index.html');
      if (fs.existsSync(htmlPath)) {
        let html = fs.readFileSync(htmlPath, 'utf-8');
        // Move inline script after <div id="root"> since defer doesn't work for inline scripts
        // Extract the script content and place it at end of body
        // The script is in <head> with type="module" — we need to move it to end of body
        // Strategy: find the script tag boundaries precisely
        const scriptStart = html.indexOf('<script type="module"');
        if (scriptStart !== -1) {
          // Find the matching </script> — it's the LAST one before </head>
          const headEnd = html.indexOf('</head>');
          const scriptEndTag = '</script>';
          let scriptEnd = html.lastIndexOf(scriptEndTag, headEnd);
          if (scriptEnd === -1) scriptEnd = html.lastIndexOf(scriptEndTag);

          const fullTag = html.slice(scriptStart, scriptEnd + scriptEndTag.length);
          // Extract JS content (after the opening tag >)
          const openTagEnd = fullTag.indexOf('>') + 1;
          const jsContent = fullTag.slice(openTagEnd, fullTag.length - scriptEndTag.length);

          // Remove the script from its original position
          html = html.slice(0, scriptStart) + html.slice(scriptEnd + scriptEndTag.length);

          // Insert before the LAST </body>
          const lastBodyIdx = html.lastIndexOf('</body>');
          if (lastBodyIdx !== -1) {
            html = html.slice(0, lastBodyIdx) + `<script>${jsContent}</script>\n</body>` + html.slice(lastBodyIdx + 7);
          }
        }
        fs.writeFileSync(htmlPath, html);
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile({ removeViteModuleLoader: true }), removeModuleType()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
