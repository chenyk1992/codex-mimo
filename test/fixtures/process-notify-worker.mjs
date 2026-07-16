import fs from "node:fs";
import { runNotificationWorker } from "../../dist/notify/worker.js";

const [cwd] = process.argv.slice(2);
if (!cwd) throw new Error("cwd is required.");

await runNotificationWorker(cwd, {
  leaseMs: Number(process.env.FAKE_NOTIFY_LEASE_MS ?? "30000")
});

if (process.env.NOTIFY_WORKER_DONE_FILE) {
  fs.writeFileSync(process.env.NOTIFY_WORKER_DONE_FILE, "done\n", "utf8");
}
