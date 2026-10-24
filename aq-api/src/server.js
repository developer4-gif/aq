import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadConfig();
const app = createApp(config);
const server = app.listen(config.port, config.host, () => {
  console.log(`AQ API + UI on http://${config.host}:${config.port}/  (notes service: ${config.pyUrl})`);
});
server.on("error", (e) => { console.error(e.code === "EADDRINUSE" ? `Port ${config.port} is already in use (set PORT).` : e.message); process.exit(1); });

function stop() {
  server.close(() => { try { app.locals.db.close(); } catch { /* already closed */ } process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
