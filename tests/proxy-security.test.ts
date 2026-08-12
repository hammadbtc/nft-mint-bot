import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import proxy from "../src/proxy";

test("proxy keeps health public but requires valid constant-time Basic auth elsewhere", () => {
  const previousUser = process.env.APP_ACCESS_USER;
  const previousPassword = process.env.APP_ACCESS_PASSWORD;
  process.env.APP_ACCESS_USER = "operator";
  process.env.APP_ACCESS_PASSWORD = "a-secure-test-password";
  try {
    assert.notEqual(proxy(new NextRequest("https://mint.example/api/health")).status, 401);
    assert.equal(proxy(new NextRequest("https://mint.example/api/jobs")).status, 401);
    const authorization = `Basic ${Buffer.from("operator:a-secure-test-password").toString("base64")}`;
    assert.notEqual(proxy(new NextRequest("https://mint.example/api/jobs", { headers: { authorization } })).status, 401);
  } finally {
    if (previousUser === undefined) delete process.env.APP_ACCESS_USER; else process.env.APP_ACCESS_USER = previousUser;
    if (previousPassword === undefined) delete process.env.APP_ACCESS_PASSWORD; else process.env.APP_ACCESS_PASSWORD = previousPassword;
  }
});

test("proxy rejects cross-site browser mutations even with valid auth", () => {
  const previousPassword = process.env.APP_ACCESS_PASSWORD;
  process.env.APP_ACCESS_PASSWORD = "a-secure-test-password";
  try {
    const authorization = `Basic ${Buffer.from("mintbot:a-secure-test-password").toString("base64")}`;
    const response = proxy(new NextRequest("https://mint.example/api/jobs/batch", {
      method: "POST",
      headers: { authorization, origin: "https://evil.example", "sec-fetch-site": "cross-site", host: "mint.example" },
    }));
    assert.equal(response.status, 403);
  } finally {
    if (previousPassword === undefined) delete process.env.APP_ACCESS_PASSWORD; else process.env.APP_ACCESS_PASSWORD = previousPassword;
  }
});
