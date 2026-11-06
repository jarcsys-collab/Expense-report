import "./setup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLocalMongo } from "../scripts/localOnly.js";

test("local test scripts accept only a MongoDB on this machine", () => {
  for (const ok of ["mongodb://127.0.0.1:27017", "mongodb://localhost:27017/", "mongodb://[::1]:27017", "mongodb://user:pw@localhost:27017/x"]) {
    assert.doesNotThrow(() => assertLocalMongo(ok, "receiptflow-local"), ok);
  }
});

test("Atlas, remote hosts, production-looking names and NODE_ENV=production are refused", () => {
  const refused = [
    ["mongodb+srv://u:p@cluster0.abcd.mongodb.net/?retryWrites=true", "receiptflow-local"],
    ["mongodb://cluster0-shard-00-00.abcd.mongodb.net:27017", "receiptflow-local"],
    ["mongodb://db.example.com:27017", "receiptflow-local"],
    ["mongodb://localhost:27017,db.example.com:27017", "receiptflow-local"],
    ["mongodb://localhost:27017", "receiptflow-prod"],
    ["", "receiptflow-local"],
  ];
  for (const [uri, db] of refused) {
    assert.throws(() => assertLocalMongo(uri, db), /Refusing to run/, uri);
    try {
      assertLocalMongo(uri, db);
    } catch (error) {
      assert.ok(!error.message.includes("u:p@"), "the connection string is never echoed");
    }
  }
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => assertLocalMongo("mongodb://localhost:27017", "receiptflow-local"), /NODE_ENV is production/);
  } finally {
    process.env.NODE_ENV = previous;
  }
});
