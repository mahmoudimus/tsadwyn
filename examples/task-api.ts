/**
 * Example: A task management API with 3 API versions, demonstrating the
 * full tsadwyn surface:
 *
 *   • schema + endpoint DSL (request/response migrations, field renames)
 *   • exceptionMap + errorMapper — domain exceptions → HttpError
 *   • deletedResponseSchema      — Stripe-style DELETE envelope
 *   • raw()                      — binary / CSV export
 *   • migratePayloadToVersion    — outbound webhooks versioned to each
 *                                    subscriber's pinned version
 *   • buildBehaviorResolver      — per-version feature flags
 *   • onUnsupportedVersion       — strict 400 on bad x-api-version
 *
 * Run:   npx tsx examples/task-api.ts
 * Test:  curl commands are printed on startup
 */
import crypto from "node:crypto";
import { z } from "zod";
import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  schema,
  convertRequestToNextVersionFor,
  convertResponseToPreviousVersionFor,
  RequestInfo,
  ResponseInfo,
  HttpError,
  exceptionMap,
  deletedResponseSchema,
  raw,
  migratePayloadToVersion,
  buildBehaviorResolver,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Schemas (latest / head version — 2024-03-01)
// ---------------------------------------------------------------------------

const TaskCreate = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  assignees: z.array(z.string()).min(1),
}).named("TaskCreate");

const TaskResource = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  assignees: z.array(z.string()),
  createdAt: z.string(),
}).named("TaskResource");

const TaskList = z.object({
  items: z.array(TaskResource),
  total: z.number(),
}).named("TaskList");

// Stripe-style DELETE envelope: { id, object: 'task', deleted: true }
// plus optional audit fields that appear only at the latest version.
const DeletedTask = deletedResponseSchema("task", {
  deleted_at: z.string().optional(),
  deleted_by: z.string().optional(),
}).named("DeletedTask");

// Webhook payload shape (sent to external subscribers per client pin).
const TaskCreatedWebhook = z.object({
  type: z.literal("task.created"),
  data: TaskResource,
  occurred_at: z.string(),
}).named("TaskCreatedWebhook");

// ---------------------------------------------------------------------------
// Domain exceptions — no HTTP semantics leak into service/model layers
// ---------------------------------------------------------------------------

class TaskNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`Task "${taskId}" not found.`);
    this.name = "TaskNotFoundError";
  }
}

class TaskValidationError extends Error {
  constructor(message: string, public readonly field: string) {
    super(message);
    this.name = "TaskValidationError";
  }
}

// ---------------------------------------------------------------------------
// In-memory database
// ---------------------------------------------------------------------------

interface Task {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  assignees: string[];
  createdAt: string;
}

const db: Record<string, Task> = {};

// ---------------------------------------------------------------------------
// Per-version behavior flags — demonstrates buildBehaviorResolver
// ---------------------------------------------------------------------------

interface TaskBehavior {
  /** Whether notifications fire on task creation. v2024-03-01 only. */
  emitNotifications: boolean;
  /** Webhook event format used when firing task.created. */
  webhookShape: "flat" | "envelope";
}

const behaviorMap = new Map<string, TaskBehavior>([
  ["2024-03-01", { emitNotifications: true, webhookShape: "envelope" }],
  ["2024-02-01", { emitNotifications: true, webhookShape: "flat" }],
  ["2024-01-01", { emitNotifications: false, webhookShape: "flat" }],
]);

const getBehavior = buildBehaviorResolver(behaviorMap, {
  emitNotifications: true,
  webhookShape: "envelope",
});

// ---------------------------------------------------------------------------
// Outbound webhook dispatcher (demonstrates migratePayloadToVersion)
//
// In real production this would write to a queue; here we just print.
// Each subscriber is pinned to an API version; the helper reshapes the
// webhook payload for their pin before delivery.
// ---------------------------------------------------------------------------

const webhookSubscribers: Array<{ url: string; pinnedVersion: string }> = [];

function registerWebhookSubscriber(url: string, pinnedVersion: string) {
  webhookSubscribers.push({ url, pinnedVersion });
}

function emitTaskCreatedWebhook(task: Task) {
  const headPayload = {
    type: "task.created" as const,
    data: task,
    occurred_at: new Date().toISOString(),
  };
  for (const sub of webhookSubscribers) {
    const shaped = migratePayloadToVersion(
      "TaskCreatedWebhook",
      headPayload,
      sub.pinnedVersion,
      app.versions,
    );
    // eslint-disable-next-line no-console
    console.log(`  → webhook ${sub.url} (pin=${sub.pinnedVersion}):`, JSON.stringify(shaped));
  }
}

// ---------------------------------------------------------------------------
// Routes (latest version only — that's the whole point!)
// ---------------------------------------------------------------------------

const router = new VersionedRouter();

// Register the webhook schema on the app.webhooks router so it appears
// in the per-version OpenAPI `webhooks:` section.
// (See `app.webhooks` registration at the bottom.)

router.post("/tasks", TaskCreate, TaskResource, async (req) => {
  const id = crypto.randomUUID();
  const task: Task = {
    id,
    title: req.body.title,
    description: req.body.description ?? null,
    priority: req.body.priority,
    assignees: req.body.assignees,
    createdAt: new Date().toISOString(),
  };
  db[id] = task;

  // Per-version behavior toggle: older versions didn't emit webhooks
  if (getBehavior().emitNotifications) {
    emitTaskCreatedWebhook(task);
  }

  return task;
});

router.get("/tasks", null, TaskList, async () => {
  const items = Object.values(db);
  return { items, total: items.length };
});

// CSV export using raw() — registered BEFORE the /:taskId wildcard so
// path-to-regexp's first-match-wins resolves to the literal. (Without
// this ordering, tsadwyn's generation-time lint warns about the
// wildcard-shadowing landmine.) Response migrations targeting this route
// would warn as dead code since the body is opaque bytes.
router.get(
  "/tasks/export.csv",
  null,
  raw({ mimeType: "text/csv; charset=utf-8" }),
  async () => {
    const items = Object.values(db);
    const lines = ["id,title,priority,assignees,createdAt"];
    for (const t of items) {
      lines.push(
        [t.id, JSON.stringify(t.title), t.priority, t.assignees.join(";"), t.createdAt].join(","),
      );
    }
    return Buffer.from(lines.join("\n"), "utf-8");
  },
);

router.get("/tasks/:taskId", null, TaskResource, async (req) => {
  const task = db[req.params.taskId];
  if (!task) {
    // Throw a DOMAIN exception — errorMapper converts to HttpError(404).
    throw new TaskNotFoundError(req.params.taskId);
  }
  return task;
});

// DELETE using the Stripe-style envelope. Note: no statusCode: 204 —
// the body MUST arrive on the wire (204 strips body per RFC 9110).
router.delete("/tasks/:taskId", null, DeletedTask, async (req) => {
  const task = db[req.params.taskId];
  if (!task) throw new TaskNotFoundError(req.params.taskId);
  delete db[req.params.taskId];
  return {
    id: req.params.taskId,
    object: "task" as const,
    deleted: true as const,
    deleted_at: new Date().toISOString(),
    deleted_by: "user:anonymous",
  };
});

// ---------------------------------------------------------------------------
// Version Changes (function-wrapper mode — no decorators needed)
// ---------------------------------------------------------------------------

/**
 * 2024-02-01 -> 2024-03-01: "critical" priority was added.
 * Also, "assignees" was a single "assignee" string field.
 */
class AddCriticalPriorityAndMultipleAssignees extends VersionChange {
  description =
    "Added 'critical' priority level and changed 'assignee' (string) to 'assignees' (array)";

  instructions = [
    schema(TaskCreate).field("assignees").had({ name: "assignee", type: z.string() }),
    schema(TaskResource).field("assignees").had({ name: "assignee", type: z.string() }),
  ];

  migrateRequest = convertRequestToNextVersionFor(TaskCreate)(
    (request: RequestInfo) => {
      request.body.assignees = [request.body.assignee];
      delete request.body.assignee;
      if (request.body.priority === "critical") {
        request.body.priority = "high";
      }
    },
  );

  migrateResponse = convertResponseToPreviousVersionFor(TaskResource)(
    (response: ResponseInfo) => {
      response.body.assignee = response.body.assignees[0];
      delete response.body.assignees;
      if (response.body.priority === "critical") {
        response.body.priority = "high";
      }
    },
  );

  // Previous version's DELETE envelope didn't include the audit fields.
  // Strip them for initial-version clients.
  migrateDeletedTask = convertResponseToPreviousVersionFor(DeletedTask)(
    (response: ResponseInfo) => {
      if (response.body) {
        delete response.body.deleted_at;
        delete response.body.deleted_by;
      }
    },
  );

  // Outbound webhook payload: v2024-02-01 subscribers get the envelope
  // form but with the flat task resource (no multi-assignee array).
  // Webhook schema isn't a response of any mounted route — it's dispatched
  // via migratePayloadToVersion(). checkUsage: false opts out of the usage
  // lint (tsadwyn can't see the outbound emission path statically).
  migrateWebhook = convertResponseToPreviousVersionFor(TaskCreatedWebhook, { checkUsage: false })(
    (response: ResponseInfo) => {
      if (response.body?.data?.assignees) {
        response.body.data.assignee = response.body.data.assignees[0];
        delete response.body.data.assignees;
      }
      if (response.body?.data?.priority === "critical") {
        response.body.data.priority = "high";
      }
    },
  );
}

/**
 * 2024-01-01 -> 2024-02-01: "description" field was added.
 */
class AddDescription extends VersionChange {
  description = "Added optional 'description' field to tasks";

  instructions = [
    schema(TaskCreate).field("description").didntExist,
    schema(TaskResource).field("description").didntExist,
  ];

  migrateRequest = convertRequestToNextVersionFor(TaskCreate)(
    (_request: RequestInfo) => {
      // Initial version doesn't send description — .optional() allows that.
    },
  );

  migrateResponse = convertResponseToPreviousVersionFor(TaskResource)(
    (response: ResponseInfo) => {
      delete response.body.description;
    },
  );

  // Initial-version webhook subscribers get a flat task without
  // description (in addition to the single-assignee migration above).
  // Webhook schema isn't a response of any mounted route — it's dispatched
  // via migratePayloadToVersion(). checkUsage: false opts out of the usage
  // lint (tsadwyn can't see the outbound emission path statically).
  migrateWebhook = convertResponseToPreviousVersionFor(TaskCreatedWebhook, { checkUsage: false })(
    (response: ResponseInfo) => {
      if (response.body?.data) {
        delete response.body.data.description;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// App — wire it all together
// ---------------------------------------------------------------------------

const app = new Tsadwyn({
  versions: new VersionBundle(
    new Version("2024-03-01", AddCriticalPriorityAndMultipleAssignees),
    new Version("2024-02-01", AddDescription),
    new Version("2024-01-01"),
  ),
  title: "Task Management API",
  apiVersionHeaderName: "x-api-version",

  // errorMapper: domain exceptions → HttpError — handlers throw
  // TaskNotFoundError and get a clean 404 with a structured body.
  // Keyed by err.name string (survives module-boundary identity drift).
  errorMapper: exceptionMap({
    TaskNotFoundError: (err) =>
      new HttpError(404, {
        code: "task_not_found",
        message: err.message,
        task_id: (err as TaskNotFoundError).taskId,
      }),
    TaskValidationError: (err) =>
      new HttpError(400, {
        code: "validation_error",
        message: err.message,
        field: (err as TaskValidationError).field,
      }),
  }),
});

// Register the webhook schema so the OpenAPI `webhooks:` section reflects
// per-version shapes. Webhook routes are documentation-only — they don't
// get mounted as HTTP endpoints; the `migratePayloadToVersion` helper is
// what actually shapes outbound payloads at dispatch time.
app.webhooks.post(
  "task.created",
  TaskCreatedWebhook,
  null,
  async () => {
    // no-op — webhooks are documented, not served
  },
);

app.generateAndIncludeVersionedRouters(router);

// Register a couple of demo subscribers pinned to different versions.
// In real production these come from a database.
registerWebhookSubscriber("https://example.com/hooks/initial-version", "2024-01-01");
registerWebhookSubscriber("https://example.com/hooks/middle-version", "2024-02-01");
registerWebhookSubscriber("https://example.com/hooks/latest", "2024-03-01");

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const PORT = 3456;
app.expressApp.listen(PORT, () => {
  console.log(`Task API running on http://localhost:${PORT}`);
  console.log(`Docs:      http://localhost:${PORT}/docs`);
  console.log(`Changelog: http://localhost:${PORT}/changelog`);
  console.log();
  console.log("--- Try these curl commands ---");
  console.log();

  console.log("# Initial version (2024-01-01): no description, single assignee, no critical priority");
  console.log(`curl -s -X POST http://localhost:${PORT}/tasks \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -H "x-api-version: 2024-01-01" \\`);
  console.log(`  -d '{"title":"Fix login bug","priority":"high","assignee":"alice"}' | jq .`);
  console.log();

  console.log("# Previous version (2024-02-01): has description, single assignee, no critical");
  console.log(`curl -s -X POST http://localhost:${PORT}/tasks \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -H "x-api-version: 2024-02-01" \\`);
  console.log(`  -d '{"title":"Add dark mode","description":"Users want dark mode","priority":"medium","assignee":"bob"}' | jq .`);
  console.log();

  console.log("# Latest version (2024-03-01): description, multiple assignees, critical priority");
  console.log(`curl -s -X POST http://localhost:${PORT}/tasks \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -H "x-api-version: 2024-03-01" \\`);
  console.log(`  -d '{"title":"Security patch","description":"Critical CVE","priority":"critical","assignees":["alice","bob"]}' | jq .`);
  console.log();

  console.log("# Domain exception → HttpError via exceptionMap (404 'task_not_found')");
  console.log(`curl -s -w '\\nstatus: %{http_code}\\n' http://localhost:${PORT}/tasks/does-not-exist -H "x-api-version: 2024-03-01" | jq .`);
  console.log();

  console.log("# DELETE: Stripe-style envelope at 200 + body (audit fields only in latest)");
  console.log(`# 1) Create a task first, capture id, then:`);
  console.log(`curl -s -X DELETE http://localhost:${PORT}/tasks/<id> -H "x-api-version: 2024-03-01" | jq .`);
  console.log(`curl -s -X DELETE http://localhost:${PORT}/tasks/<id> -H "x-api-version: 2024-01-01" | jq .  # no audit fields`);
  console.log();

  console.log("# raw() binary export as CSV — content-type text/csv on the wire");
  console.log(`curl -s -D - http://localhost:${PORT}/tasks/export.csv -H "x-api-version: 2024-03-01"`);
  console.log();

  console.log("# List all tasks (try different versions to see shape changes)");
  console.log(`curl -s http://localhost:${PORT}/tasks -H "x-api-version: 2024-01-01" | jq .`);
  console.log(`curl -s http://localhost:${PORT}/tasks -H "x-api-version: 2024-03-01" | jq .`);
  console.log();

  console.log("# Introspection (in another shell):");
  console.log(`npx tsx src/cli.ts routes      --app examples/task-api.ts --format table`);
  console.log(`npx tsx src/cli.ts migrations  --app examples/task-api.ts --schema TaskResource --version 2024-01-01`);
  console.log(`npx tsx src/cli.ts simulate    --app examples/task-api.ts --method GET --path /tasks/abc --version 2024-01-01`);
  console.log(`npx tsx src/cli.ts exceptions  --app examples/task-api.ts --format table`);
});

export { app };
