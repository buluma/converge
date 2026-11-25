/**
 * Seed script: create the RecurringTicketSeries rows for the two known
 * example support series (Team Support, Example Users Support).
 * Rerunnable — upserts on (userId, key), so editing a value below and
 * re-running updates the existing row instead of duplicating it.
 *
 * IMPORTANT: the redmineProjectId / trackerId / priorityId / categoryId /
 * assignedToId / wakatimeProjectName / customFieldsJson values below are
 * placeholders (TODO). Fill these in with the real Redmine field IDs before
 * running this against Heimdal — wrong IDs create real tickets in the wrong
 * project/tracker.
 *
 * Run: npx tsx scripts/seed-recurring-ticket-series.ts
 */

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? "file:./prisma/dev.db" }),
});

const SERIES = [
  {
    key: "team-support",
    name: "Team Support",
    redmineProjectId: 0, // TODO: real Redmine project id
    parentIssueId: 0, // TODO: real parent issue id
    trackerId: 0, // TODO: "Subtask" tracker id
    priorityId: 0, // TODO
    categoryId: null as number | null,
    assignedToId: null as number | null,
    subjectTemplate: "Week {{week}} Team Support",
    descriptionTemplate: null as string | null,
    estimatedHours: null as number | null,
    customFieldsJson: null as Array<{ id: number; value: string }> | null,
    cadence: "weekly",
    createWeekday: 1,
    closeWeekday: 7,
    createDayOfMonth: 1,
    closeDayOfMonth: null as number | null,
    wakatimeProjectName: "team-support", // TODO: real WakaTime "project" tag
    defaultActivityId: 9,
    defaultActivityName: "Development",
    expectsTime: false,
  },
  {
    key: "example-support",
    name: "Example Users Support",
    redmineProjectId: 0, // TODO: real Redmine project id
    parentIssueId: 0, // TODO: real parent issue id
    trackerId: 0, // TODO: "Task" tracker id
    priorityId: 0, // TODO
    categoryId: null as number | null,
    assignedToId: null as number | null,
    subjectTemplate: "Week {{week}}: Support for Example Users",
    descriptionTemplate: "Fixed boilerplate support description for Example Users.", // TODO: real boilerplate text
    estimatedHours: null as number | null,
    customFieldsJson: null as Array<{ id: number; value: string }> | null,
    cadence: "weekly",
    createWeekday: 1,
    closeWeekday: 7,
    createDayOfMonth: 1,
    closeDayOfMonth: null as number | null,
    wakatimeProjectName: "example-support", // TODO: real WakaTime "project" tag
    defaultActivityId: 9,
    defaultActivityName: "Development",
    expectsTime: false,
  },
];

async function main() {
  const user = await prisma.user.findFirst();
  if (!user) {
    console.log("No users found. Create a user first.");
    return;
  }

  console.log(`Seeding recurring ticket series for user: ${user.displayName} (${user.id})`);

  for (const data of SERIES) {
    const series = await prisma.recurringTicketSeries.upsert({
      where: { userId_key: { userId: user.id, key: data.key } },
      update: { ...data, customFieldsJson: data.customFieldsJson ?? undefined },
      create: { ...data, userId: user.id, customFieldsJson: data.customFieldsJson ?? undefined },
    });
    console.log(`  ✅ ${series.key}: ${series.name}`);
  }

  console.log("Done! Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
