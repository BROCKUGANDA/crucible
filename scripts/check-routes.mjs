// Gate 808 smoke check: every new showcase route must resolve (200) on a running
// dev/preview server. Usage: BASE_URL=http://localhost:3000 node scripts/check-routes.mjs
const BASE = process.env.BASE_URL || "http://localhost:3000";
const routes = ["/showcase", "/ghost", "/replay/1", "/hall", "/claims", "/bounties"];

async function main() {
  let failed = 0;
  for (const r of routes) {
    try {
      const res = await fetch(BASE + r);
      const ok = res.status === 200;
      console.log(`${ok ? "OK  " : "FAIL"} ${r} -> ${res.status}`);
      if (!ok) failed++;
    } catch (e) {
      console.log(`FAIL ${r} -> ${e.message}`);
      failed++;
    }
  }
  if (failed > 0) {
    console.error(`${failed} route(s) failed`);
    process.exit(1);
  }
  console.log("all routes green");
}

main();
