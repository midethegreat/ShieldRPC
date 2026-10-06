import "dotenv/config";
import { createApp, initDb } from "./app.js";

async function main() {
  const PORT = Number(process.env.PORT ?? 3001);

  // Kick off DB init in the background. HTTP server starts even if DB is
  // unavailable initially; /v1/health reports status. Reconnects are handled
  // lazily by node-postgres on each query.
  initDb().then(
    (state: { isConnected: boolean; initializationError: string | null }) => {
      if (state.isConnected) {
        console.log("[shieldrpc-api] connected to postgres ✓");
      } else {
        console.warn(
          `[shieldrpc-api] postgres unavailable — scoring continues but nothing persists. ` +
            `Set DATABASE_URL and run "docker compose up db" (or apply the schema with ` +
            `"npm run db:apply-schema"). DB error: ${state.initializationError}`,
        );
      }
    },
  );

  const app = createApp();
  app.listen(PORT, () => {
    console.log(`[shieldrpc-api] running on http://localhost:${PORT}`);
    console.log(
      `[shieldrpc-api] health:   GET  http://localhost:${PORT}/v1/health`,
    );
    console.log(
      `[shieldrpc-api] analyze:  POST http://localhost:${PORT}/v1/analyze-transaction`,
    );
  });
}

main();
