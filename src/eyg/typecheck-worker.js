// Type checks one program off the server's main thread. Inference can take
// exponential time on contrived programs, so the server runs it in a worker
// with a time limit.
import { parentPort, workerData } from "node:worker_threads";
import { typeErrors } from "./typecheck.js";

try {
  parentPort.postMessage({ ok: true, errors: typeErrors(workerData) });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message });
}
