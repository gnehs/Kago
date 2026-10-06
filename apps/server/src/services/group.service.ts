import { z } from "zod";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";

export const createGroupSchema = z.object({ name: z.string().min(1).max(120) });

type GroupMember = { id: string; email: string; display_name: string };

export class GroupService {
  constructor(private readonly db: Db) {}

  list() {
    const members = rows<GroupMember & { group_id: string }>(
      this.db
        .prepare(
          `SELECT group_members.group_id, users.id, users.email, users.display_name
          FROM group_members JOIN users ON users.id = group_members.user_id
          ORDER BY users.email ASC`
        )
        .all()
    );
    return rows<{ id: string }>(this.db.prepare("SELECT * FROM groups ORDER BY name ASC").all()).map((group) => ({
      ...group,
      members: members.filter((member) => member.group_id === group.id).map(({ group_id: _groupId, ...member }) => member)
    }));
  }

  create(name: string) {
    const ts = now();
    const group = { id: id("group"), name, created_at: ts, updated_at: ts };
    this.db.prepare("INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
      group.id,
      group.name,
      group.created_at,
      group.updated_at
    );
    return group;
  }

  addMember(groupId: string, userId: string) {
    this.assertGroupExists(groupId);
    this.assertUserExists(userId);
    this.db
      .prepare("INSERT OR REPLACE INTO group_members (group_id, user_id, role) VALUES (?, ?, 'MEMBER')")
      .run(groupId, userId);
  }

  removeMember(groupId: string, userId: string) {
    this.assertGroupExists(groupId);
    this.db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(groupId, userId);
  }

  private assertGroupExists(groupId: string): void {
    const group = row<{ id: string }>(this.db.prepare("SELECT id FROM groups WHERE id = ?").get(groupId));
    if (!group) throw new AppError(404, "Group not found", "GROUP_NOT_FOUND");
  }

  private assertUserExists(userId: string): void {
    const user = row<{ id: string }>(this.db.prepare("SELECT id FROM users WHERE id = ?").get(userId));
    if (!user) throw new AppError(404, "User not found", "USER_NOT_FOUND");
  }
}
