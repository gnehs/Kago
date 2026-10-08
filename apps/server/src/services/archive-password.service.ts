import { z } from "zod";
import type { Db } from "../db/db.js";
import { rows } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";
import type { SecretBox } from "../lib/secret-box.js";

export const archivePasswordSchema = z.object({
  password: z.string().min(1).max(1024),
  note: z.string().trim().max(80).default("")
});

const MAX_ARCHIVE_PASSWORDS = 50;

type ArchivePasswordRow = { id: string; sealed: string; note: string; created_at: number };

/**
 * The passwords a person has said to try on a locked archive before asking them.
 * They are kept sealed and never sent back: the list names each by its note and the day it was added.
 */
export class ArchivePasswordService {
  constructor(
    private readonly db: Db,
    private readonly secrets: () => SecretBox
  ) {}

  list(userId: string): Array<{ id: string; note: string; createdAt: number }> {
    return this.rows(userId).map((item) => ({ id: item.id, note: item.note, createdAt: item.created_at }));
  }

  /** The passwords themselves, oldest first; for the task that opens an archive, not for a response. */
  reveal(userId: string): string[] {
    const box = this.secrets();
    return this.rows(userId).flatMap((item) => {
      try {
        return [box.open(item.sealed)];
      } catch {
        // Sealed with a key that is no longer there; it can only be removed.
        return [];
      }
    });
  }

  /** Adding one that is already kept changes nothing. */
  add(userId: string, input: z.infer<typeof archivePasswordSchema>) {
    if (!this.reveal(userId).includes(input.password)) {
      if (this.rows(userId).length >= MAX_ARCHIVE_PASSWORDS) throw new AppError(400, "Too many saved archive passwords", "ARCHIVE_PASSWORD_LIMIT");
      this.db
        .prepare("INSERT INTO archive_passwords (id, user_id, sealed, note, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id("zpw"), userId, this.secrets().seal(input.password), input.note, now());
    }
    return this.list(userId);
  }

  remove(userId: string, passwordId: string) {
    this.db.prepare("DELETE FROM archive_passwords WHERE id = ? AND user_id = ?").run(passwordId, userId);
    return this.list(userId);
  }

  private rows(userId: string): ArchivePasswordRow[] {
    return rows<ArchivePasswordRow>(this.db.prepare("SELECT id, sealed, note, created_at FROM archive_passwords WHERE user_id = ? ORDER BY created_at ASC, id ASC").all(userId));
  }
}
