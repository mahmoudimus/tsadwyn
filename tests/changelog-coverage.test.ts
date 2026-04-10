/**
 * Comprehensive coverage tests for src/changelog.ts.
 *
 * These tests target the generateChangelog() function directly by constructing
 * VersionBundles with a variety of schema/endpoint/enum instructions and
 * asserting on the emitted changelog shape.
 *
 * Run: npx vitest run tests/changelog-coverage.test.ts
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  Version,
  VersionBundle,
  VersionChange,
  VersionChangeWithSideEffects,
  schema,
  endpoint,
  enum_,
  hidden,
  generateChangelog,
} from "../src/index.js";
import type {
  ChangelogInstruction,
  ChangelogAttributeChange,
} from "../src/changelog.js";

// ---------------------------------------------------------------------------
// Section 1: Schema field changelog entries
// ---------------------------------------------------------------------------

describe("changelog: schema field entries", () => {
  it("1. field_added — existedAs produces schema.field.added for older version", () => {
    // From the old version's perspective the field was added in the newer version,
    // so `existedAs` (field existed as X in the older version) is a schema.field.removed
    // from the old version's perspective in the changelog. The inverse — `didntExist`
    // meaning the field didn't exist in the older version — is schema.field.added.
    const Resource = z
      .object({
        id: z.string(),
        newField: z.string(),
      })
      .named("CCov_FieldAddedResource");

    class AddField extends VersionChange {
      description = "Added newField";
      instructions = [schema(Resource).field("newField").didntExist];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", AddField),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const change = changelog.versions[0].changes[0];
    const entry = change.instructions[0];

    expect(entry.type).toBe("schema.field.added");
    if (entry.type === "schema.field.added") {
      expect(entry.schema).toBe("CCov_FieldAddedResource");
      expect(entry.field).toBe("newField");
    }
  });

  it("2. field_removed — existedAs produces schema.field.removed", () => {
    // `existedAs` means the field was present in the older version, i.e. it was
    // later removed. The changelog should describe this as a removal.
    const Resource = z
      .object({
        id: z.string(),
      })
      .named("CCov_FieldRemovedResource");

    class RemoveField extends VersionChange {
      description = "Removed legacyField";
      instructions = [
        schema(Resource).field("legacyField").existedAs({ type: z.string() }),
      ];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", RemoveField),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];

    expect(entry.type).toBe("schema.field.removed");
    if (entry.type === "schema.field.removed") {
      expect(entry.schema).toBe("CCov_FieldRemovedResource");
      expect(entry.field).toBe("legacyField");
    }
  });

  it("3. field_renamed — had({ name }) produces attribute change with old/new name", () => {
    const Resource = z
      .object({
        id: z.string(),
        displayName: z.string(),
      })
      .named("CCov_RenameResource");

    class Rename extends VersionChange {
      description = "Rename username to displayName";
      instructions = [
        schema(Resource).field("displayName").had({ name: "username" }),
      ];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", Rename),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];

    expect(entry.type).toBe("schema.field.attributes.changed");
    if (entry.type === "schema.field.attributes.changed") {
      expect(entry.schema).toBe("CCov_RenameResource");
      // The changelog uses the oldName as the display field name when renaming
      expect(entry.field).toBe("username");

      const nameChange = entry.attributeChanges.find((c) => c.name === "name");
      expect(nameChange).toBeDefined();
      expect(nameChange!.status).toBe("changed");
      expect(nameChange!.oldValue).toBe("username");
      expect(nameChange!.newValue).toBe("displayName");
    }
  });

  it("4. field_type_changed — had({ type }) produces JSON Schema representations", () => {
    const Resource = z
      .object({
        count: z.number(),
      })
      .named("CCov_TypeResource");

    class ChangeType extends VersionChange {
      description = "count used to be a string";
      instructions = [
        schema(Resource).field("count").had({ type: z.string() }),
      ];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", ChangeType),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];

    expect(entry.type).toBe("schema.field.attributes.changed");
    if (entry.type === "schema.field.attributes.changed") {
      const typeChange = entry.attributeChanges.find((c) => c.name === "type");
      expect(typeChange).toBeDefined();
      expect(typeChange!.status).toBe("changed");
      // oldValue should be a JSON Schema describing the previous (string) type
      expect(typeChange!.oldValue).toBeDefined();
      expect(typeChange!.oldValue).not.toBeNull();
      // The old type was z.string(), so we expect the JSON Schema to reflect that
      expect(typeChange!.oldValue).toMatchObject({ type: "string" });
      // $schema key should be stripped
      expect(typeChange!.oldValue).not.toHaveProperty("$schema");
      // Bug 3 fix: newValue should be populated with the current type's JSON Schema
      expect(typeChange!.newValue).toBeDefined();
      expect(typeChange!.newValue).not.toBeNull();
      // The current type is z.number(), so JSON Schema should reflect that
      expect(typeChange!.newValue).toMatchObject({ type: "number" });
      expect(typeChange!.newValue).not.toHaveProperty("$schema");
    }
  });

  it("5. field_constraint_added — didntHave('min') produces an attributes changed entry", () => {
    const Resource = z
      .object({
        age: z.number().min(18),
      })
      .named("CCov_ConstraintAddedResource");

    class AddMin extends VersionChange {
      description = "Added a minimum age constraint";
      instructions = [schema(Resource).field("age").didntHave("min")];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", AddMin),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];

    expect(entry.type).toBe("schema.field.attributes.changed");
    if (entry.type === "schema.field.attributes.changed") {
      expect(entry.schema).toBe("CCov_ConstraintAddedResource");
      expect(entry.field).toBe("age");
      expect(entry.attributeChanges).toHaveLength(1);

      const minChange = entry.attributeChanges[0];
      expect(minChange.name).toBe("min");
      expect(minChange.status).toBe("added");
      expect(minChange.oldValue).toBeNull();
      expect(minChange.newValue).toBeNull();
    }
  });

  it("5b. field_constraint_added — didntHave with multiple constraints produces one entry per attribute", () => {
    const Resource = z
      .object({
        name: z.string().min(1).max(100),
      })
      .named("CCov_MultiConstraintResource");

    class AddConstraints extends VersionChange {
      description = "Added minLength and maxLength";
      instructions = [
        schema(Resource).field("name").didntHave("minLength", "maxLength"),
      ];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", AddConstraints),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];
    expect(entry.type).toBe("schema.field.attributes.changed");
    if (entry.type === "schema.field.attributes.changed") {
      const names = entry.attributeChanges.map((c) => c.name).sort();
      expect(names).toEqual(["maxLength", "minLength"]);
      for (const change of entry.attributeChanges) {
        expect(change.status).toBe("added");
      }
    }
  });

  it("6. field_multiple_attribute_changes — a single had() with multiple attributes produces one entry per attribute", () => {
    const Resource = z
      .object({
        email: z.string(),
      })
      .named("CCov_MultiAttrResource");

    class MultiChange extends VersionChange {
      description = "email used to have several different constraints";
      instructions = [
        schema(Resource)
          .field("email")
          .had({
            minLength: 5,
            maxLength: 100,
            description: "user's email address",
          }),
      ];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", MultiChange),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];

    expect(entry.type).toBe("schema.field.attributes.changed");
    if (entry.type === "schema.field.attributes.changed") {
      // One entry per attribute change in the had() call
      const names = entry.attributeChanges.map((c) => c.name).sort();
      expect(names).toEqual(["description", "maxLength", "minLength"]);

      const minLength = entry.attributeChanges.find(
        (c) => c.name === "minLength",
      )!;
      expect(minLength.oldValue).toBe(5);
      const maxLength = entry.attributeChanges.find(
        (c) => c.name === "maxLength",
      )!;
      expect(maxLength.oldValue).toBe(100);
      const desc = entry.attributeChanges.find(
        (c) => c.name === "description",
      )!;
      expect(desc.oldValue).toBe("user's email address");
    }
  });

  it("7. field_description_changed — had({ description }) produces an old description entry", () => {
    const Resource = z
      .object({
        note: z.string(),
      })
      .named("CCov_DescResource");

    class ChangeDesc extends VersionChange {
      description = "note's description was updated";
      instructions = [
        schema(Resource).field("note").had({ description: "old description" }),
      ];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", ChangeDesc),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];
    expect(entry.type).toBe("schema.field.attributes.changed");
    if (entry.type === "schema.field.attributes.changed") {
      const descChange = entry.attributeChanges.find(
        (c) => c.name === "description",
      );
      expect(descChange).toBeDefined();
      expect(descChange!.oldValue).toBe("old description");
    }
  });
});

// ---------------------------------------------------------------------------
// Section 2: Schema-level changelog entries
// ---------------------------------------------------------------------------

describe("changelog: schema-level entries", () => {
  it("8. schema_renamed — schema().had({ name }) produces a schema.changed entry", () => {
    const Resource = z
      .object({
        id: z.string(),
      })
      .named("CCov_NewName");

    class RenameSchema extends VersionChange {
      description = "Renamed from OldName to CCov_NewName";
      instructions = [schema(Resource).had({ name: "CCov_OldName" })];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", RenameSchema),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];

    expect(entry.type).toBe("schema.changed");
    if (entry.type === "schema.changed") {
      // The old schema name becomes the `schema` field in the entry
      expect(entry.schema).toBe("CCov_OldName");
      expect(entry.modifiedAttributes).toEqual({ name: "CCov_NewName" });
    }
  });
});

// ---------------------------------------------------------------------------
// Section 3: Endpoint changelog entries
// ---------------------------------------------------------------------------

describe("changelog: endpoint entries", () => {
  it("9. endpoint_added — didntExist produces endpoint.added", () => {
    class AddEndpoint extends VersionChange {
      description = "Added /widgets endpoint";
      instructions = [endpoint("/widgets", ["POST"]).didntExist];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", AddEndpoint),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];

    expect(entry.type).toBe("endpoint.added");
    if (entry.type === "endpoint.added") {
      expect(entry.path).toBe("/widgets");
      expect(entry.methods).toEqual(["POST"]);
    }
  });

  it("10. endpoint_removed — existed produces endpoint.removed", () => {
    class RemoveEndpoint extends VersionChange {
      description = "Removed /legacy endpoint";
      instructions = [endpoint("/legacy", ["GET", "DELETE"]).existed];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", RemoveEndpoint),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];

    expect(entry.type).toBe("endpoint.removed");
    if (entry.type === "endpoint.removed") {
      expect(entry.path).toBe("/legacy");
      expect(entry.methods).toEqual(["GET", "DELETE"]);
    }
  });

  it("11. endpoint_changed_path — had({ path }) produces endpoint.changed with path attribute", () => {
    class ChangePath extends VersionChange {
      description = "path was renamed";
      instructions = [endpoint("/new", ["GET"]).had({ path: "/old" })];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", ChangePath),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];

    expect(entry.type).toBe("endpoint.changed");
    if (entry.type === "endpoint.changed") {
      expect(entry.path).toBe("/new");
      expect(entry.methods).toEqual(["GET"]);
      const pathChange = entry.changes.find((c) => c.name === "path");
      expect(pathChange).toBeDefined();
      expect(pathChange!.newValue).toBe("/old");
    }
  });

  it("12. endpoint_changed_status_code — had({ statusCode })", () => {
    class ChangeStatus extends VersionChange {
      description = "status code changed";
      instructions = [endpoint("/items", ["POST"]).had({ statusCode: 201 })];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", ChangeStatus),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];

    expect(entry.type).toBe("endpoint.changed");
    if (entry.type === "endpoint.changed") {
      const statusChange = entry.changes.find((c) => c.name === "statusCode");
      expect(statusChange).toBeDefined();
      expect(statusChange!.newValue).toBe(201);
    }
  });

  it("13. endpoint_changed_deprecated — had({ deprecated })", () => {
    class Deprecate extends VersionChange {
      description = "deprecated the /items endpoint";
      instructions = [endpoint("/items", ["GET"]).had({ deprecated: true })];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", Deprecate),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];

    expect(entry.type).toBe("endpoint.changed");
    if (entry.type === "endpoint.changed") {
      const deprecated = entry.changes.find((c) => c.name === "deprecated");
      expect(deprecated).toBeDefined();
      expect(deprecated!.newValue).toBe(true);
    }
  });

  it("14. endpoint_changed_tags — had({ tags })", () => {
    class ChangeTags extends VersionChange {
      description = "tag update";
      instructions = [
        endpoint("/items", ["GET"]).had({ tags: ["old-tag-1", "old-tag-2"] }),
      ];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", ChangeTags),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];

    expect(entry.type).toBe("endpoint.changed");
    if (entry.type === "endpoint.changed") {
      const tagsChange = entry.changes.find((c) => c.name === "tags");
      expect(tagsChange).toBeDefined();
      expect(tagsChange!.newValue).toEqual(["old-tag-1", "old-tag-2"]);
    }
  });

  it("endpoint_changed_multiple_attrs — had() with several attributes produces multiple change entries", () => {
    class MultiChange extends VersionChange {
      description = "summary, description, operationId changed";
      instructions = [
        endpoint("/items", ["GET"]).had({
          summary: "old summary",
          description: "old description",
          operationId: "oldOperationId",
        }),
      ];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", MultiChange),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];
    expect(entry.type).toBe("endpoint.changed");
    if (entry.type === "endpoint.changed") {
      const names = entry.changes.map((c) => c.name).sort();
      expect(names).toEqual(["description", "operationId", "summary"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 4: Enum changelog entries
// ---------------------------------------------------------------------------

describe("changelog: enum entries", () => {
  it("15. enum_member_removed — had({ member: 'value' }) produces enum.members.removed", () => {
    // `had({ X: "value" })` means the OLD version had X. Going old -> new,
    // X was REMOVED in the new version.
    const StatusEnum = z
      .enum(["active", "inactive"])
      .named("CCov_StatusEnum");

    class RemoveArchived extends VersionChange {
      description = "archived status was removed";
      instructions = [enum_(StatusEnum).had({ archived: "archived" })];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", RemoveArchived),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];

    expect(entry.type).toBe("enum.members.removed");
    if (entry.type === "enum.members.removed") {
      expect(entry.enum).toBe("CCov_StatusEnum");
      expect(entry.members).toEqual({ archived: "archived" });
    }
  });

  it("16. enum_member_added — didntHave('member') produces enum.members.added", () => {
    // `didntHave("X")` means the OLD version didn't have X. Going old -> new,
    // X was ADDED in the new version.
    const PriorityEnum = z
      .enum(["low", "medium", "high", "urgent"])
      .named("CCov_PriorityEnum");

    class AddUrgent extends VersionChange {
      description = "urgent priority was added";
      instructions = [enum_(PriorityEnum).didntHave("urgent")];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", AddUrgent),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const entry = changelog.versions[0].changes[0].instructions[0];

    expect(entry.type).toBe("enum.members.added");
    if (entry.type === "enum.members.added") {
      expect(entry.enum).toBe("CCov_PriorityEnum");
      expect(entry.members).toEqual(["urgent"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 5: Hidden instructions
// ---------------------------------------------------------------------------

describe("changelog: hidden instructions", () => {
  it("17. hidden instruction is excluded from changelog", () => {
    const Resource = z
      .object({
        id: z.string(),
        internal: z.string(),
      })
      .named("CCov_HiddenInstrResource");

    class Hide extends VersionChange {
      description = "only some fields are documented";
      instructions = [
        hidden(schema(Resource).field("internal").didntExist),
      ];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", Hide),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const change = changelog.versions[0].changes[0];
    expect(change.instructions).toHaveLength(0);
  });

  it("18. hidden entire VersionChange is excluded from changelog", () => {
    const Resource = z
      .object({
        id: z.string(),
      })
      .named("CCov_HiddenChangeResource");

    class VisibleChange extends VersionChange {
      description = "this one is visible";
      instructions = [schema(Resource).field("id").didntExist];
    }

    class SecretChange extends VersionChange {
      description = "this one should be hidden";
      instructions = [schema(Resource).field("id").didntExist];
    }
    // Mark the entire class as hidden
    hidden(SecretChange);

    const bundle = new VersionBundle(
      new Version("2024-11-01", SecretChange),
      new Version("2024-06-01", VisibleChange),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);

    // The hidden change should NOT appear in the hidden version's changes list
    const hiddenVersion = changelog.versions.find((v) => v.value === "2024-11-01");
    expect(hiddenVersion).toBeDefined();
    const hiddenChangeEntry = hiddenVersion!.changes.find(
      (c) => c.description === "this one should be hidden",
    );
    expect(hiddenChangeEntry).toBeUndefined();

    // The visible change should still appear
    const visibleVersion = changelog.versions.find(
      (v) => v.value === "2024-06-01",
    );
    expect(visibleVersion).toBeDefined();
    expect(
      visibleVersion!.changes.some(
        (c) => c.description === "this one is visible",
      ),
    ).toBe(true);
  });

  it("19. hidden and visible instructions can be mixed in one VersionChange", () => {
    const Resource = z
      .object({
        id: z.string(),
        secret: z.string(),
        public_: z.string(),
      })
      .named("CCov_MixedVisResource");

    class Mixed extends VersionChange {
      description = "some fields are hidden";
      instructions = [
        // Visible: public_ was added (didn't exist before)
        schema(Resource).field("public_").didntExist,
        // Hidden: secret was added (didn't exist before) — but we want to keep
        // this change internal
        hidden(schema(Resource).field("secret").didntExist),
      ];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", Mixed),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    const change = changelog.versions[0].changes[0];

    // Only the public_ change should be emitted
    expect(change.instructions).toHaveLength(1);
    const visible = change.instructions[0];
    expect(visible.type).toBe("schema.field.added");
    if (visible.type === "schema.field.added") {
      expect(visible.field).toBe("public_");
    }

    // No instruction with field "secret" should appear
    const secretInstr = change.instructions.find(
      (i) =>
        (i.type === "schema.field.added" || i.type === "schema.field.removed") &&
        (i as any).field === "secret",
    );
    expect(secretInstr).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Section 6: Multi-version changelog
// ---------------------------------------------------------------------------

describe("changelog: multi-version aggregation", () => {
  it("20. multiple versions are aggregated in newest-first order", () => {
    class ChangeV2 extends VersionChange {
      description = "change in v2";
      instructions = [endpoint("/v2-endpoint", ["POST"]).didntExist];
    }

    class ChangeV3 extends VersionChange {
      description = "change in v3";
      instructions = [endpoint("/v3-endpoint", ["POST"]).didntExist];
    }

    const bundle = new VersionBundle(
      new Version("2024-11-01", ChangeV3),
      new Version("2024-06-01", ChangeV2),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);

    // Oldest version (2024-01-01) has no changes and is skipped
    expect(changelog.versions).toHaveLength(2);
    // Newest-first ordering
    expect(changelog.versions[0].value).toBe("2024-11-01");
    expect(changelog.versions[1].value).toBe("2024-06-01");

    expect(changelog.versions[0].changes[0].description).toBe("change in v3");
    expect(changelog.versions[1].changes[0].description).toBe("change in v2");
  });

  it("21. empty instructions array produces a change entry with no sub-instructions", () => {
    class Empty extends VersionChange {
      description = "a note without instructions";
      instructions = [];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", Empty),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    expect(changelog.versions).toHaveLength(1);
    const change = changelog.versions[0].changes[0];
    expect(change.description).toBe("a note without instructions");
    expect(change.instructions).toHaveLength(0);
    expect(change.sideEffects).toBe(false);
  });

  it("22. VersionChangeWithSideEffects is flagged, VersionChange is not", () => {
    class SideEffect extends VersionChangeWithSideEffects {
      description = "has side effects";
      instructions = [];
    }

    class Regular extends VersionChange {
      description = "no side effects";
      instructions = [];
    }

    const bundle = new VersionBundle(
      new Version("2024-11-01", SideEffect),
      new Version("2024-06-01", Regular),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);

    const sideEffectVersion = changelog.versions.find(
      (v) => v.value === "2024-11-01",
    );
    expect(sideEffectVersion).toBeDefined();
    expect(sideEffectVersion!.changes[0].sideEffects).toBe(true);

    const regularVersion = changelog.versions.find(
      (v) => v.value === "2024-06-01",
    );
    expect(regularVersion).toBeDefined();
    expect(regularVersion!.changes[0].sideEffects).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 7: Description and metadata
// ---------------------------------------------------------------------------

describe("changelog: description and shape", () => {
  it("23. description is preserved verbatim on the change entry", () => {
    const longDescription =
      "This is a long, detailed description that explains " +
      "exactly what changed and why it matters. It may span " +
      "multiple sentences and include special characters: <>&.";

    class DescribedChange extends VersionChange {
      description = longDescription;
      instructions = [];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", DescribedChange),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);
    expect(changelog.versions[0].changes[0].description).toBe(longDescription);
  });

  it("24. changelog returns the expected top-level shape", () => {
    class SomeChange extends VersionChange {
      description = "a change";
      instructions = [];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", SomeChange),
      new Version("2024-01-01"),
    );

    const changelog = generateChangelog(bundle);

    // Top-level is { versions: [...] }
    expect(Array.isArray(changelog.versions)).toBe(true);
    expect(Object.keys(changelog)).toEqual(["versions"]);

    // Each version entry is { value, changes: [...] }
    const v = changelog.versions[0];
    expect(typeof v.value).toBe("string");
    expect(Array.isArray(v.changes)).toBe(true);

    // Each change has description, sideEffects, instructions
    const change = v.changes[0];
    expect(typeof change.description).toBe("string");
    expect(typeof change.sideEffects).toBe("boolean");
    expect(Array.isArray(change.instructions)).toBe(true);
  });

  it("bundle with no non-oldest version changes produces empty changelog", () => {
    // Only oldest version exists → no changes at all
    const bundle = new VersionBundle(new Version("2024-01-01"));
    const changelog = generateChangelog(bundle);
    expect(changelog.versions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Section 8: Field had() constraint coverage
//
// These tests exercise every constraint branch in convertSchemaInstruction's
// `field_had` handler to push coverage of src/changelog.ts.
// ---------------------------------------------------------------------------

describe("changelog: field_had constraint coverage", () => {
  function getFieldChange(instructionsArray: any[]): ChangelogAttributeChange[] {
    class Change extends VersionChange {
      description = "constraint test";
      instructions = instructionsArray;
    }
    const bundle = new VersionBundle(
      new Version("2024-06-01", Change),
      new Version("2024-01-01"),
    );
    const cl = generateChangelog(bundle);
    const entry = cl.versions[0].changes[0].instructions[0];
    if (entry.type !== "schema.field.attributes.changed") {
      throw new Error(`Expected schema.field.attributes.changed, got ${entry.type}`);
    }
    return entry.attributeChanges;
  }

  it("had({ default }) emits a default attribute change with hasDefault flag", () => {
    const S = z.object({ x: z.number() }).named("CCov_DefaultCov");
    const changes = getFieldChange([
      schema(S).field("x").had({ default: 42 }),
    ]);
    const d = changes.find((c) => c.name === "default")!;
    expect(d).toBeDefined();
    expect(d.oldValue).toBe(42);
  });

  it("had({ optional }) emits an optional attribute change", () => {
    const S = z.object({ x: z.string() }).named("CCov_OptionalCov");
    const changes = getFieldChange([
      schema(S).field("x").had({ optional: true }),
    ]);
    expect(changes.find((c) => c.name === "optional")).toMatchObject({
      oldValue: true,
    });
  });

  it("had({ nullable }) emits a nullable attribute change", () => {
    const S = z.object({ x: z.string() }).named("CCov_NullableCov");
    const changes = getFieldChange([
      schema(S).field("x").had({ nullable: true }),
    ]);
    expect(changes.find((c) => c.name === "nullable")).toMatchObject({
      oldValue: true,
    });
  });

  it("had({ min, max }) emits min and max attribute changes", () => {
    const S = z.object({ age: z.number() }).named("CCov_MinMaxCov");
    const changes = getFieldChange([
      schema(S).field("age").had({ min: 1, max: 99 }),
    ]);
    expect(changes.find((c) => c.name === "min")).toMatchObject({ oldValue: 1 });
    expect(changes.find((c) => c.name === "max")).toMatchObject({ oldValue: 99 });
  });

  it("had({ minLength, maxLength }) emits length attribute changes", () => {
    const S = z.object({ name: z.string() }).named("CCov_LenCov");
    const changes = getFieldChange([
      schema(S).field("name").had({ minLength: 3, maxLength: 50 }),
    ]);
    expect(changes.find((c) => c.name === "minLength")).toMatchObject({
      oldValue: 3,
    });
    expect(changes.find((c) => c.name === "maxLength")).toMatchObject({
      oldValue: 50,
    });
  });

  it("had({ gt, gte, lt, lte }) emits comparison attribute changes", () => {
    const S = z.object({ n: z.number() }).named("CCov_CmpCov");
    const changes = getFieldChange([
      schema(S).field("n").had({ gt: 0, gte: 1, lt: 100, lte: 99 }),
    ]);
    expect(changes.find((c) => c.name === "gt")).toMatchObject({ oldValue: 0 });
    expect(changes.find((c) => c.name === "gte")).toMatchObject({ oldValue: 1 });
    expect(changes.find((c) => c.name === "lt")).toMatchObject({ oldValue: 100 });
    expect(changes.find((c) => c.name === "lte")).toMatchObject({ oldValue: 99 });
  });

  it("had({ regex }) emits a regex attribute change with the pattern source", () => {
    const S = z.object({ code: z.string() }).named("CCov_RegexCov");
    const changes = getFieldChange([
      schema(S).field("code").had({ regex: /^[A-Z]+$/ }),
    ]);
    const r = changes.find((c) => c.name === "regex")!;
    expect(r).toBeDefined();
    expect(r.oldValue).toBe("^[A-Z]+$");
  });

  it("had({ pattern }) emits a pattern attribute change with the pattern source", () => {
    const S = z.object({ code: z.string() }).named("CCov_PatternCov");
    const changes = getFieldChange([
      schema(S).field("code").had({ pattern: /abc/ }),
    ]);
    const p = changes.find((c) => c.name === "pattern")!;
    expect(p).toBeDefined();
    expect(p.oldValue).toBe("abc");
  });

  it("had({ multipleOf }) emits a multipleOf attribute change", () => {
    const S = z.object({ n: z.number() }).named("CCov_MultipleCov");
    const changes = getFieldChange([
      schema(S).field("n").had({ multipleOf: 5 }),
    ]);
    expect(changes.find((c) => c.name === "multipleOf")).toMatchObject({
      oldValue: 5,
    });
  });

  it("had({ int }) emits an int attribute change", () => {
    const S = z.object({ n: z.number() }).named("CCov_IntCov");
    const changes = getFieldChange([
      schema(S).field("n").had({ int: true }),
    ]);
    expect(changes.find((c) => c.name === "int")).toMatchObject({
      oldValue: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Section 9: Endpoint had() methods attribute coverage
// ---------------------------------------------------------------------------

describe("changelog: endpoint.had methods attribute", () => {
  it("had({ methods }) emits a methods attribute change", () => {
    class ChangeMethods extends VersionChange {
      description = "methods changed";
      instructions = [
        endpoint("/things", ["POST"]).had({ methods: ["GET"] }),
      ];
    }

    const bundle = new VersionBundle(
      new Version("2024-06-01", ChangeMethods),
      new Version("2024-01-01"),
    );
    const cl = generateChangelog(bundle);
    const entry = cl.versions[0].changes[0].instructions[0];
    expect(entry.type).toBe("endpoint.changed");
    if (entry.type === "endpoint.changed") {
      const m = entry.changes.find((c) => c.name === "methods");
      expect(m).toBeDefined();
      expect(m!.newValue).toEqual(["GET"]);
    }
  });
});

