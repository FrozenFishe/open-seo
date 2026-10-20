import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHostedContext } from "@/middleware/ensure-user/hosted";
import { autumn } from "@/server/billing/autumn";
// oxlint-disable-next-line import/no-unassigned-import -- the mocked createFileRoute below captures the route's handlers
import "./$";

// The "-" prefix keeps the router generator from treating this as a route.

type Handler = (ctx: { request: Request }) => Promise<Response>;
const route = vi.hoisted(() => ({ handlers: {} as Record<string, Handler> }));

vi.mock("cloudflare:workers", () => ({ env: { AUTH_MODE: "hosted" } }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () => (options: { server: { handlers: Record<string, Handler> } }) => {
      route.handlers = options.server.handlers;
      return options;
    },
}));
vi.mock("@/middleware/ensure-user/hosted", () => ({
  resolveHostedContext: vi.fn(),
}));
vi.mock("@/server/billing/autumn", () => ({
  autumn: { customers: { getOrCreate: vi.fn() } },
}));

// An attacker-shaped body: another organization's customer and plan fields.
const post = (endpoint: string) =>
  route.handlers.POST({
    request: new Request(`https://app.openseo.so/api/autumn/${endpoint}`, {
      method: "POST",
      body: JSON.stringify({ customerId: "org_other", productId: "pro" }),
    }),
  });

beforeEach(() => {
  vi.mocked(resolveHostedContext).mockResolvedValue({
    userId: "user_1",
    userEmail: "alice@example.com",
    emailVerified: true,
    organizationId: "org_caller",
    role: "owner",
  });
  vi.mocked(autumn.customers.getOrCreate).mockResolvedValue(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the route returns the Autumn customer as-is
    { id: "org_caller" } as Awaited<
      ReturnType<typeof autumn.customers.getOrCreate>
    >,
  );
});

describe("Autumn proxy route", () => {
  it("reads only the caller's organization, ignoring the request body", async () => {
    const response = await post("getOrCreateCustomer");

    expect(response.status).toBe(200);
    expect(autumn.customers.getOrCreate).toHaveBeenCalledExactlyOnceWith({
      customerId: "org_caller",
      email: "alice@example.com",
      expand: ["balances.feature", "subscriptions.plan"],
    });
  });

  it("rejects an unauthenticated caller before calling Autumn", async () => {
    vi.mocked(resolveHostedContext).mockRejectedValue(
      new Error("UNAUTHENTICATED"),
    );

    const response = await post("getOrCreateCustomer");

    expect(response.status).toBe(401);
    expect(autumn.customers.getOrCreate).not.toHaveBeenCalled();
  });

  it("never forwards any other Autumn endpoint, even for a signed-in caller", async () => {
    const response = await post("attach");

    expect(response.status).toBe(410);
    expect(autumn.customers.getOrCreate).not.toHaveBeenCalled();
  });
});
