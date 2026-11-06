// Runs one match off the server's main thread.
import { parentPort, workerData } from "node:worker_threads";
import { Match } from "./match.js";

try {
  const match = new Match(workerData);
  match.run();
  parentPort.postMessage({ ok: true, replay: match.replay() });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message, errors: e.errors });
}
