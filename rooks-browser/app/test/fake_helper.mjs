// A stand-in for `rooks-browser serve`, for ui.test.mjs only. It writes the environment it was started with to the file
// named first on its command line (so a test can see what the app handed it), answers /healthz on the port main.js
// chose, and runs one pretend job that ends in an error, so the panel's wording for that can be checked.
import { writeFileSync } from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
const dump = args[0];
const port = Number(args[args.indexOf("--port") + 1]);
writeFileSync(dump, JSON.stringify(process.env));

const job = { id: "job1", status: "error", steps: [], pending_approvals: [], result: null,
  error: "RuntimeError: could not read the page: Script failed to execute (line 3)" };
http.createServer((req, res) => {
  const ok = (body) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/healthz") return ok({ ok: true });
  if (req.method === "POST" && req.url === "/api/jobs") return ok({ ...job, status: "queued", error: null });  // as a real one starts
  if (req.url === "/api/jobs/job1") return ok(job);
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ detail: "Not found" }));
}).listen(port, "127.0.0.1");
process.stdin.on("end", () => process.exit(0));  // the app went away
process.stdin.resume();
