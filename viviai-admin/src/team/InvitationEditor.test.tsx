import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { AdminClient } from "../http";
import { json } from "../test/fixtures";
import { TeamPage } from "./TeamPage";
import type { TeamInvitation } from "./contracts";
import { permissionEntries, roleOptions, teamActor } from "./test-fixtures";

it.each(["expired", "revoked"] as const)(
  "explicitly removes a deleted historical role from a %s invitation before editing and regenerating",
  async (status) => {
    // The referenced custom role was deleted after the invitation ceased to be live.
    const invitation: TeamInvitation = {
      id: "old-invitation",
      email: "returning@example.test",
      displayName: "返岗同事",
      roles: [
        {
          key: "retired",
          name: "旧运营角色",
          builtIn: false,
          permissions: ["dashboard.read"],
        },
        roleOptions[1],
      ],
      status,
      version: 3,
      createdAt: "2026-09-08T00:00:00Z",
      expiresAt: "2026-09-09T00:00:00Z",
      allowedActions: ["edit", "rotate", "revoke"].map((action) => ({
        action: action as "edit" | "rotate" | "revoke",
        allowed: true,
        reasonCode: null,
      })),
    };
    const commands: { method: string; body: Record<string, unknown> }[] = [];
    const page = (items: unknown[]) => ({
      items,
      nextCursor: null,
      asOf: "2026-09-10T00:00:00Z",
      allowedActions: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (raw: string, init?: RequestInit) => {
        const path = new URL(raw, "http://localhost:3010").pathname.replace(
          "/api/admin",
          "",
        );
        const method = init?.method ?? "GET";
        if (method === "GET") {
          if (path === "/team/permission-catalog")
            return json({
              permissions: permissionEntries,
              assignableRoles: roleOptions,
              writeEnabled: true,
            });
          if (path === "/team/members") return json(page([]));
          if (path === "/team/invitations") return json(page([invitation]));
          return json(null, 404);
        }
        const body = JSON.parse(String(init?.body));
        commands.push({ method, body });
        if (body.expectedVersion !== invitation.version) return json(null, 409);
        if (path === "/team/invitations/old-invitation" && method === "PATCH") {
          if (
            !Array.isArray(body.roles) ||
            body.roles.some(
              (key: string) => !roleOptions.some((r) => r.key === key),
            )
          )
            return json(null, 400);
          invitation.roles = roleOptions.filter((r) =>
            body.roles.includes(r.key),
          );
          invitation.version++;
          invitation.status = "revoked";
          return json({
            resourceId: invitation.id,
            version: invitation.version,
          });
        }
        if (
          path === "/team/invitations/old-invitation/rotate" &&
          method === "POST"
        ) {
          if (
            invitation.roles.some(
              (r) => !roleOptions.some((option) => option.key === r.key),
            )
          )
            return json(null, 400);
          invitation.version++;
          invitation.status = "pending";
          return json(
            {
              resourceId: invitation.id,
              version: invitation.version,
              link: `http://localhost:3010/#/accept?token=${"a".repeat(43)}`,
              expiresAt: "2026-09-11T00:00:00Z",
            },
            201,
          );
        }
        return json(null, 404);
      }),
    );
    const user = userEvent.setup();
    render(
      <TeamPage
        actor={teamActor}
        client={new AdminClient()}
        onPermissionsChanged={async () => {}}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "待激活邀请" }));
    await user.click(
      within(
        (await screen.findByText(invitation.email)).closest("tr")!,
      ).getByRole("button", { name: "编辑" }),
    );
    const remove = screen.getByRole("button", { name: "移除角色 旧运营角色" });
    expect(screen.getByText(/历史角色当前不可分配/)).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "旧运营角色" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "模型运营" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "客服" }));
    await user.type(screen.getByLabelText("操作原因"), "替换已删除的历史角色");
    await user.click(screen.getByRole("button", { name: "保存邀请" }));
    expect(
      await screen.findByText("请先移除不可分配的历史角色"),
    ).toBeInTheDocument();
    expect(commands).toHaveLength(0);
    await user.click(remove);
    expect(
      screen.queryByRole("button", { name: "移除角色 旧运营角色" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存邀请" }));
    await screen.findByText("邀请已更新；角色变化后请重新生成链接");
    expect(commands[0]).toMatchObject({
      method: "PATCH",
      body: {
        roles: ["model_operator", "support"],
        expectedVersion: 3,
      },
    });
    await user.click(screen.getByRole("button", { name: "完成" }));
    await user.click(
      within(
        (await screen.findByText(invitation.email)).closest("tr")!,
      ).getByRole("button", { name: "重新生成" }),
    );
    await user.type(screen.getByLabelText("操作原因"), "重新邀请返岗同事");
    await user.click(screen.getByRole("button", { name: "重新生成链接" }));
    await screen.findByText("邀请链接已重新生成，旧链接已失效");
    expect(commands[1]).toMatchObject({
      method: "POST",
      body: { expectedVersion: 4 },
    });
    expect(screen.getByLabelText("一次性链接")).toHaveValue(
      `http://localhost:3010/#/accept?token=${"a".repeat(43)}`,
    );
    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(
      within(
        (await screen.findByText(invitation.email)).closest("tr")!,
      ).getByText("待激活"),
    ).toBeInTheDocument();
  },
);
