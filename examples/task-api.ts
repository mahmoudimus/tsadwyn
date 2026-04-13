/**
 * Example: A task management API with 3 API versions.
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
// Routes (latest version only — that's the whole point!)
// ---------------------------------------------------------------------------

const router = new VersionedRouter();

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
  return task;
});

router.get("/tasks", null, TaskList, async () => {
  const items = Object.values(db);
  return { items, total: items.length };
});

router.get("/tasks/:taskId", null, TaskResource, async (req) => {
  const task = db[req.params.taskId];
  if (!task) throw new Error("Task not found");
  return task;
});

router.delete("/tasks/:taskId", null, null, async (req) => {
  delete db[req.params.taskId];
  return { deleted: true };
});

// ---------------------------------------------------------------------------
// Version Changes (using function-wrapper mode — no decorators needed)
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

  // Function-wrapper mode: wrap the migration function directly
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
    (request: RequestInfo) => {
      // Old version doesn't send description — leave it undefined so .optional() passes
    },
  );

  migrateResponse = convertResponseToPreviousVersionFor(TaskResource)(
    (response: ResponseInfo) => {
      delete response.body.description;
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
});

app.generateAndIncludeVersionedRouters(router);

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

  console.log("# v2024-01-01 (oldest): no description, single assignee, no critical priority");
  console.log(`curl -s -X POST http://localhost:${PORT}/tasks \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -H "x-api-version: 2024-01-01" \\`);
  console.log(`  -d '{"title":"Fix login bug","priority":"high","assignee":"alice"}' | jq .`);
  console.log();

  console.log("# v2024-02-01 (middle): has description, single assignee, no critical");
  console.log(`curl -s -X POST http://localhost:${PORT}/tasks \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -H "x-api-version: 2024-02-01" \\`);
  console.log(`  -d '{"title":"Add dark mode","description":"Users want dark mode","priority":"medium","assignee":"bob"}' | jq .`);
  console.log();

  console.log("# v2024-03-01 (latest): has description, multiple assignees, has critical");
  console.log(`curl -s -X POST http://localhost:${PORT}/tasks \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -H "x-api-version: 2024-03-01" \\`);
  console.log(`  -d '{"title":"Security patch","description":"Critical CVE","priority":"critical","assignees":["alice","bob"]}' | jq .`);
  console.log();

  console.log("# List all tasks (try with different versions to see different shapes)");
  console.log(`curl -s http://localhost:${PORT}/tasks -H "x-api-version: 2024-01-01" | jq .`);
  console.log(`curl -s http://localhost:${PORT}/tasks -H "x-api-version: 2024-03-01" | jq .`);
});

export { app };
