import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import proxy from "../src/proxy";

test("proxy keeps liveness and readiness public but requires valid constant-time Basic auth elsewhere", () => {
  const previousUser = process.env.APP_ACCESS_USER;
  const previousPassword = process.env.APP_ACCESS_PASSWORD;
  process.env.APP_ACCESS_USER = "operator";
  process.env.APP_ACCESS_PASSWORD = "a-secure-test-password";
  try {
    assert.notEqual(proxy(new NextRequest("https://mint.example/api/health")).status, 401);
    assert.notEqual(proxy(new NextRequest("https://mint.example/api/live")).status, 401);
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

test("proxy applies nonce-based script and style-element CSP without unsafe inline scripts", () => {
  const response = proxy(new NextRequest("https://mint.example/api/live"));
  const policy = response.headers.get("content-security-policy") || "";
  assert.match(policy, /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  assert.match(policy, /style-src-elem 'self' 'nonce-[^']+'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  assert.match(response.headers.get("x-middleware-request-content-security-policy") || "", /nonce-/);
});

test("proxy caps authenticated mutation bodies before route parsing", () => {
  const previousPassword = process.env.APP_ACCESS_PASSWORD;
  process.env.APP_ACCESS_PASSWORD = "a-secure-test-password";
  try {
    const authorization = `Basic ${Buffer.from("mintbot:a-secure-test-password").toString("base64")}`;
    const response = proxy(new NextRequest("https://mint.example/api/jobs/batch", {
      method: "POST",
      headers: { authorization, "content-length": "1000001" },
    }));
    assert.equal(response.status, 413);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    if (previousPassword === undefined) delete process.env.APP_ACCESS_PASSWORD; else process.env.APP_ACCESS_PASSWORD = previousPassword;
  }
});

test("proxy rejects unbounded mutation streams", () => {
  const response = proxy(new NextRequest("https://mint.example/api/jobs/batch", {
    method: "POST",
    body: "{}",
    headers: { "transfer-encoding": "chunked" },
  }));
  assert.equal(response.status, 411);
});

test("proxy rate-limits unauthenticated public health probe floods", () => {
  const headers = { "x-forwarded-for": "203.0.113.77" };
  for (let index = 0; index < 120; index += 1) {
    assert.notEqual(proxy(new NextRequest("https://mint.example/api/health", { headers })).status, 429);
  }
  const response = proxy(new NextRequest("https://mint.example/api/health", { headers }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
});
