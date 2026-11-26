// Smart access: reading never asks (one approval layer, whole-word write
// detection); only real changes ask; Claude Code doesn't double-ask.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./_load.mjs";

test("reading never asks; only real changes do", async () => {
  const tools = await load("src/tools/index.ts");
  for (const read of ["GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "GMAIL_LIST_THREADS", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLEDRIVE_FIND_FILE", "GOOGLEDRIVE_DOWNLOAD_FILE", "FACEBOOK_GET_POSTS", "HUBSPOT_GET_CONTACT_ADDRESS", "SHEETS_GET_INPUT_RANGE", "web_search", "phone_notifications"])
    assert.equal(tools.isWriteAction(read), false, read);
  for (const write of ["GMAIL_SEND_EMAIL", "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_MOVE_TO_TRASH", "GMAIL_ADD_LABEL_TO_EMAIL", "GOOGLECALENDAR_CREATE_EVENT", "GOOGLECALENDAR_DELETE_EVENT", "GOOGLEDRIVE_UPLOAD_FILE", "SLACK_SET_STATUS", "GMAIL_BATCH_MODIFY_MESSAGES", "routine_create", "OUTLOOK_REPLY_EMAIL", "GMAIL_ARCHIVE_EMAIL"])
    assert.equal(tools.isWriteAction(write), true, write);
});

test("Claude Code: MausDroid's tools pre-approved, read-only allowed, commands ask once", async () => {
  const cli = await load("src/providers/cli.ts");
  const args = cli.cliArgs({ engine: "claude", prompt: "x", systemPrompt: "s", mcpUrl: "u", mcpToken: "t" });
  const i = args.indexOf("--allowedTools");
  assert.ok(i > 0);
  assert.deepEqual(args.slice(i + 1, i + 1 + cli.CLI_ALLOWED_TOOLS.length), cli.CLI_ALLOWED_TOOLS);
  assert.ok(cli.CLI_ALLOWED_TOOLS.includes("mcp__mausdroid"));
  assert.ok(!cli.CLI_ALLOWED_TOOLS.some((t) => /^(Bash|Edit|Write)$/.test(t)), "commands and file changes aren't pre-approved");
  assert.equal(cli.cliPermission("mcp__mausdroid__composio__COMPOSIO_MULTI_EXECUTE_TOOL"), "allow", "MausDroid gates its own tools when they run");
  assert.equal(cli.cliPermission("WebFetch"), "allow");
  assert.equal(cli.cliPermission("Read"), "allow");
  assert.equal(cli.cliPermission("Bash"), "ask");
  assert.equal(cli.cliPermission("Write"), "ask");
  assert.equal(cli.cliPermission("mcp__other__thing"), "ask");
});
