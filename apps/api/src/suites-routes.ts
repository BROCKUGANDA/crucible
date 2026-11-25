/**
 * @file suites-routes.ts — Hono routes for the benchmark suite registry.
 *
 * Provides CRUD operations for suites, suite versions, and adversarial tests.
 * Uses PostgreSQL-backed stores when DATABASE_URL is set, falls back to
 * in-memory stores otherwise.
 */

import { Hono } from "hono";
import { verifiedSessionFromContext } from "./auth.js";
import { paginate, parsePage } from "./pagination.js";
import {
  createSuite,
  getSuite,
  listSuites,
  updateSuiteStatus,
  createSuiteVersion,
  getSuiteVersion,
  createAdversarialTest,
  getAdversarialTestsForSuiteVersion,
  type Suite,
  type CreateSuiteInput,
  type CreateSuiteVersionInput,
  type CreateAdversarialTestInput,
} from "./suites.js";
import {
  pgCreateSuite,
  pgGetSuite,
  pgListSuites,
  pgUpdateSuiteStatus,
  pgCreateSuiteVersion,
  pgGetSuiteVersion,
  pgListSuiteVersions,
  pgCreateAdversarialTest,
  pgGetAdversarialTest,
  pgListAdversarialTests,
} from "./suites-pg.js";

const usePg = !!process.env.DATABASE_URL;

export function createSuitesRoutes(): Hono {
  const app = new Hono();

  // List suites
  app.get("/", async (c) => {
    const status = c.req.query("status");
    const visibility = c.req.query("visibility");
    const search = c.req.query("search");
    const page = parsePage(c.req.query());

    const suites = usePg
      ? await pgListSuites({ status: status as any, visibility: visibility as any, search })
      : listSuites({ status: status as any, visibility: visibility as any, search });

    const paginated = paginate(suites, (s: Suite) => s.createdAt, page);
    return c.json(paginated);
  });

  // Create suite
  app.post("/", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const input = await c.req.json<CreateSuiteInput>();
    const principal = {
      principalId: session.payload.address,
      orgId: (session.payload as any).orgId ?? null,
    };

    try {
      const suite = usePg
        ? await pgCreateSuite(input, principal as any)
        : createSuite(input, principal as any);
      return c.json(suite, 201);
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });

  // Get suite by ID
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const suite = usePg ? await pgGetSuite(id) : getSuite(id);
    if (!suite) return c.json({ error: "Suite not found" }, 404);
    return c.json(suite);
  });

  // Update suite status
  app.patch("/:id/status", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const id = c.req.param("id");
    const { status } = await c.req.json();

    const suite = usePg
      ? await pgUpdateSuiteStatus(id, status)
      : updateSuiteStatus(id, status);

    if (!suite) return c.json({ error: "Suite not found" }, 404);
    return c.json(suite);
  });

  // List suite versions
  app.get("/:id/versions", async (c) => {
    const id = c.req.param("id");
    const status = c.req.query("status");
    const versions = usePg
      ? await pgListSuiteVersions(id, { status })
      : [];
    return c.json(versions);
  });

  // Create suite version
  app.post("/:id/versions", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const suiteId = c.req.param("id");
    const input = await c.req.json<CreateSuiteVersionInput>();
    input.suiteId = suiteId;

    try {
      const version = usePg
        ? await pgCreateSuiteVersion(input)
        : createSuiteVersion(input);
      return c.json(version, 201);
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });

  // Get suite version by ID
  app.get("/versions/:versionId", async (c) => {
    const versionId = c.req.param("versionId");
    const version = usePg
      ? await pgGetSuiteVersion(versionId)
      : getSuiteVersion(versionId);
    if (!version) return c.json({ error: "Suite version not found" }, 404);
    return c.json(version);
  });

  // List adversarial tests for suite version
  app.get("/versions/:versionId/adversarial", async (c) => {
    const versionId = c.req.param("versionId");
    const category = c.req.query("category");
    const severity = c.req.query("severity");
    const tests = usePg
      ? await pgListAdversarialTests(versionId, { category: category as any, severity: severity as any })
      : getAdversarialTestsForSuiteVersion(versionId, { category: category as any, severity: severity as any });
    return c.json(tests);
  });

  // Create adversarial test
  app.post("/versions/:versionId/adversarial", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const versionId = c.req.param("versionId");
    const input = await c.req.json<CreateAdversarialTestInput>();
    input.suiteVersionId = versionId;

    try {
      const test = usePg
        ? await pgCreateAdversarialTest(input)
        : createAdversarialTest(input);
      return c.json(test, 201);
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });

  return app;
}
