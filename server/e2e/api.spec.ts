import { test, expect } from "@playwright/test";

test.describe("API Endpoints", () => {
  test("GET /health returns 200 with status ok", async ({ request }) => {
    const response = await request.get("/health");

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("status", "ok");
  });

  test("GET /api/history returns 200 with cards array", async ({ request }) => {
    const response = await request.get("/api/history");

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("cards");
    expect(Array.isArray(body.cards)).toBe(true);
  });

  test("GET /api/queries returns 200 with queries array", async ({ request }) => {
    const response = await request.get("/api/queries");

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("queries");
    expect(Array.isArray(body.queries)).toBe(true);
  });

  test("GET /api/sessions returns 200 with sessions array", async ({ request }) => {
    const response = await request.get("/api/sessions");

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("sessions");
    expect(Array.isArray(body.sessions)).toBe(true);
  });
});
