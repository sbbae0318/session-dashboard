import { test, expect } from "@playwright/test";

test.describe("Machine API Endpoints", () => {
  test("GET /api/machines returns 200 with machines array", async ({ request }) => {
    const response = await request.get("/api/machines");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("machines");
    expect(Array.isArray(body.machines)).toBe(true);
  });

  test("/api/machines items have required fields", async ({ request }) => {
    const response = await request.get("/api/machines");
    const body = await response.json();
    if (body.machines.length > 0) {
      const machine = body.machines[0];
      expect(machine).toHaveProperty("id");
      expect(machine).toHaveProperty("alias");
      expect(machine).toHaveProperty("host");
      expect(machine).toHaveProperty("status");
      expect(["connected", "disconnected"]).toContain(machine.status);
    }
  });

  test("GET /health includes machine counts", async ({ request }) => {
    const response = await request.get("/health");
    const body = await response.json();
    expect(body).toHaveProperty("connectedMachines");
    expect(body).toHaveProperty("totalMachines");
    expect(typeof body.connectedMachines).toBe("number");
    expect(typeof body.totalMachines).toBe("number");
  });

  test("/api/machines does not expose apiKey", async ({ request }) => {
    const response = await request.get("/api/machines");
    const body = await response.json();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("apiKey");
  });
});
