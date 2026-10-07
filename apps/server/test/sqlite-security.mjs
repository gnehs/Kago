import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { sqliteOverview, sqliteRows } from "../dist/lib/sqlite-preview.js";

test("SQLite previews isolate views, time out expensive SELECTs, and release worker slots", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kago-sqlite-security-"));
  const file = path.join(directory, "fixture.sqlite");

  try {
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE records (id INTEGER PRIMARY KEY, title TEXT NOT NULL, payload BLOB, big INTEGER);
      INSERT INTO records (title, payload, big)
        VALUES ('first', x'00ff10', 9007199254740993), ('second', NULL, 2), ('third', NULL, 3);
      CREATE TABLE binary_values (payload BLOB);
      CREATE VIEW titles AS SELECT title, title FROM records;
      CREATE VIEW generated AS
        WITH RECURSIVE seq(n) AS (
          VALUES(1)
          UNION ALL
          SELECT n + 1 FROM seq WHERE n < 1000000000
        )
        SELECT n FROM seq;
      CREATE VIEW oversized_value AS SELECT randomblob(100 * 1024 * 1024) AS payload;
      CREATE VIEW expensive_select AS
        WITH RECURSIVE seq(n) AS (
          VALUES(1)
          UNION ALL
          SELECT n + 1 FROM seq WHERE n < 1000000000
        )
        SELECT max(n) AS n FROM seq;
    `);
    db.prepare("INSERT INTO binary_values VALUES (zeroblob(?))").run(12 * 1024 * 1024);
    db.close();
    const size = (await stat(file)).size;

    const overview = await sqliteOverview(file);
    assert.ok(overview.tables.some((table) => table.name === "records" && table.type === "table"));
    assert.ok(overview.tables.some((table) => table.name === "titles" && table.type === "view"));

    const tablePage = await sqliteRows(file, size, "records", 0, 2);
    assert.deepEqual(tablePage.rows, [[1, "first", { blob: 3 }, "9007199254740993"], [2, "second", null, 2]]);
    assert.equal(tablePage.total, 3);
    assert.equal(tablePage.hasMore, true);

    const binaryPage = await sqliteRows(file, size, "binary_values", 0, 1);
    assert.deepEqual(binaryPage.rows, [[{ blob: 12 * 1024 * 1024 }]]);

    const titlePage = await sqliteRows(file, size, "titles", 0, 2);
    assert.deepEqual(titlePage.rows, [["first", "first"], ["second", "second"]]);
    assert.equal(titlePage.total, null);

    const generatedPage = await sqliteRows(file, size, "generated", 0, 2);
    assert.deepEqual(generatedPage.rows, [[1], [2]]);
    assert.equal(generatedPage.total, null);
    assert.equal(generatedPage.hasMore, true);

    await assert.rejects(
      sqliteRows(file, size, "oversized_value", 0, 1),
      (error) => error.code === "SQLITE_PREVIEW_TOO_LARGE" && error.statusCode === 413
    );

    // Two expensive views occupy both child slots; a third request is rejected instead of queued.
    const firstSlowQuery = sqliteRows(file, size, "expensive_select", 0, 1);
    const secondSlowQuery = sqliteRows(file, size, "expensive_select", 0, 1);
    await assert.rejects(
      sqliteRows(file, size, "expensive_select", 0, 1),
      (error) => error.code === "SQLITE_PREVIEW_BUSY" && error.statusCode === 503
    );
    const slowResults = await Promise.allSettled([firstSlowQuery, secondSlowQuery]);
    assert.equal(slowResults.length, 2);
    for (const result of slowResults) {
      assert.equal(result.status, "rejected");
      assert.equal(result.reason.code, "SQLITE_PREVIEW_TIMEOUT");
      assert.equal(result.reason.statusCode, 504);
    }

    // A timed-out child is gone before its slot is reused.
    const recoveredPage = await sqliteRows(file, size, "records", 2, 1);
    assert.deepEqual(recoveredPage.rows, [[3, "third", null, 3]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
