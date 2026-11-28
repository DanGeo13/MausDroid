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

test("Claude Code: DanDroid's tools pre-approved, read-only allowed, commands ask once", async () => {
  const cli = await load("src/providers/cli.ts");
  const args = cli.cliArgs({ engine: "claude", prompt: "x", systemPrompt: "s", mcpUrl: "u", mcpToken: "t" });
  const i = args.indexOf("--allowedTools");
  assert.ok(i > 0);
  assert.deepEqual(args.slice(i + 1, i + 1 + cli.CLI_ALLOWED_TOOLS.length), cli.CLI_ALLOWED_TOOLS);
  assert.ok(cli.CLI_ALLOWED_TOOLS.includes("mcp__mausdroid"));
  // Claude Code doesn't ask (DanDroid's own gate is the only approval layer); its risky tools are off.
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  const d = args.indexOf("--disallowedTools");
  for (const t of ["Bash", "Edit", "Write"]) assert.ok(args.slice(d + 1, d + 1 + cli.CLI_DISALLOWED_TOOLS.length).includes(t), t);
  assert.ok(!args.includes("--permission-prompt-tool"));
  assert.ok(!cli.CLI_ALLOWED_TOOLS.some((t) => /^(Bash|Edit|Write)$/.test(t)), "commands and file changes aren't pre-approved");
  assert.equal(cli.cliPermission("mcp__mausdroid__composio__COMPOSIO_MULTI_EXECUTE_TOOL"), "allow", "DanDroid gates its own tools when they run");
  assert.equal(cli.cliPermission("WebFetch"), "allow");
  assert.equal(cli.cliPermission("Read"), "allow");
  assert.equal(cli.cliPermission("Bash"), "ask");
  assert.equal(cli.cliPermission("Write"), "ask");
  assert.equal(cli.cliPermission("mcp__other__thing"), "ask");
});

test("existing chats catch up on access changes once; new bots start up to date", async () => {
  const { fakeModel, startEngine, useModel } = await import("./_engine.mjs");
  const m = await fakeModel(() => ({ text: "ok" }));
  const e = await startEngine();
  try {
    await useModel(e, m.url);
    const maus = (await e.call("/api/state")).data.bots.find((b) => b.name === "Maus");
    // A bot from before the change (it never saw an access update), with its chat history.
    await e.call(`/api/bots/${maus.id}`, "PATCH", { accessSeen: null });
    await e.call(`/api/bots/${maus.id}/messages`, "POST", { text: "read my email" });
    await e.until(async () => (await e.call(`/api/bots/${maus.id}/messages`)).data.some((x) => x.role === "assistant" && x.text === "ok"), "reply");
    const firstAsk = JSON.stringify(m.seen.at(-1).messages.at(-1));
    assert.match(firstAsk, /DanDroid update since earlier in this chat: Reading no longer needs approval/);
    assert.match(firstAsk, /Claude Code's own approval step is switched off/);
    assert.match(firstAsk, /read my email/);
    const msgs = (await e.call(`/api/bots/${maus.id}/messages`)).data;
    assert.ok(msgs.some((x) => x.role === "note" && /access was updated/.test(x.text)), "the person sees it too");
    // Only once.
    await e.call(`/api/bots/${maus.id}/messages`, "POST", { text: "again" });
    await e.until(async () => (await e.call(`/api/bots/${maus.id}/messages`)).data.filter((x) => x.role === "assistant" && x.text === "ok").length === 2, "second reply");
    assert.ok(!JSON.stringify(m.seen.at(-1).messages.at(-1)).includes("DanDroid update"), "not repeated");
    // A new bot starts with today's rules.
    const nb = (await e.call("/api/bots", "POST", { name: "Fresh" })).data;
    await e.call(`/api/bots/${nb.id}/messages`, "POST", { text: "hi" });
    await e.until(async () => (await e.call(`/api/bots/${nb.id}/messages`)).data.some((x) => x.role === "assistant" && x.text === "ok"), "fresh reply");
    assert.ok(!JSON.stringify(m.seen.at(-1).messages.at(-1)).includes("DanDroid update"));
    // Every bot is told to retry rather than trust earlier "blocked" results.
    assert.match(JSON.stringify(m.seen.at(-1).messages[0]), /try the tool again before saying something can't be reached/);
  } finally {
    await e.stop();
    m.close();
  }
});

test("Claude tool results show what really happened", async () => {
  const cli = await load("src/providers/cli.ts");
  const use = cli.parseCliLine("claude", JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__mausdroid__browser_open", input: { url: "x" } }] } }), { text: "" });
  assert.deepEqual(use, [{ kind: "tool", name: "mcp__mausdroid__browser_open", input: { url: "x" }, toolId: "tu1" }]);
  const res = cli.parseCliLine("claude", JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: [{ type: "text", text: "Claude requested permissions to use mcp__mausdroid__browser_open, but you haven't granted it yet." }] }] } }), { text: "" });
  assert.equal(res[0].toolId, "tu1");
  assert.equal(res[0].isError, true);
  assert.match(res[0].text, /haven't granted it yet/);
});

test("Codex delegates DanDroid approvals on fresh and resumed conversations", async () => {
  const { cliArgs, parseCliLine } = await load("src/providers/cli.ts");
  const run = { engine: "codex", prompt: "Read my email", systemPrompt: "instructions", mcpUrl: "http://localhost/mcp/bot", mcpToken: "token" };
  for (const resume of [undefined, "existing-thread"]) {
    const args = cliArgs({ ...run, resume });
    if (resume) assert.deepEqual(args.slice(0, 3), ["exec", "resume", resume]);
    assert.deepEqual(args.slice(args.indexOf("--disable"), args.indexOf("--disable") + 2), ["--disable", "apps"]);
    assert.ok(args.includes('mcp_servers.mausdroid.default_tools_approval_mode="approve"'));
    assert.equal(args.at(-1), resume ? run.prompt : `${run.systemPrompt}\n\n${run.prompt}`);
  }
  const item = { type: "mcp_tool_call", id: "item_1", tool: "browser_open", arguments: { url: "https://example.org" } };
  const parse = (type, fields) => parseCliLine("codex", JSON.stringify({ type, item: { ...item, ...fields } }), { text: "" });
  assert.deepEqual(parse("item.started"), [{ kind: "tool", name: item.tool, input: item.arguments, toolId: item.id }]);
  assert.deepEqual(parse("item.completed", { status: "failed", error: { message: "Permission denied" } }), [
    { kind: "tool_result", toolId: item.id, isError: true, text: "Permission denied" },
  ]);
});

test("a resumed Codex bot gets its current settings after an in-place edit", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { createServer } = await import("node:http");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { startEngine } = await import("./_engine.mjs");
  const runs = [];
  const companion = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    runs.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end([
      { type: "thread.started", thread_id: "existing-thread" },
      { type: "item.completed", item: { type: "agent_message", text: "checked" } },
      { type: "turn.completed" },
    ].map(JSON.stringify).join("\n"));
  });
  await new Promise((resolve) => companion.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), "md-legacy-bot-"));
  writeFileSync(join(dir, "bots.json"), JSON.stringify([{
    id: "bot_legacy", name: "Maus", persona: "", skills: [], unread: 0, providerId: "chatgpt",
    cliSession: "existing-thread", tools: { browser: false },
  }]));
  const e = await startEngine({ dir });
  try {
    await e.call("/api/settings/providers/chatgpt", "PUT", {
      enabled: true, runOn: "computer", computerUrl: `http://127.0.0.1:${companion.address().port}`,
    });
    const bot = (await e.call("/api/state")).data.bots[0];
    assert.equal(bot.id, "bot_legacy");
    assert.equal(bot.approvalMode, "ask-risky");
    assert.deepEqual(bot.alwaysAllow, []);
    assert.deepEqual(bot.tools, { web: true, browser: false, apps: true, phone: false });
    const route = `/api/bots/${bot.id}`;
    await e.call(route, "PATCH", { approvalMode: "ask-all" });
    await e.call(`${route}/messages`, "POST", { text: "Read the performer email" });
    const replies = async () => (await e.call(`${route}/messages`)).data.filter((msg) => msg.role === "assistant");
    await e.until(async () => (await replies()).length === 1, "first Codex reply");
    assert.match(runs[0].prompt, /asks for approval for tool actions, including reads/);

    await e.call(route, "PATCH", { approvalMode: "ask-risky" });
    await e.call(`${route}/messages`, "POST", { text: "Retry the existing email request" });
    await e.until(async () => (await replies()).length === 2, "second Codex reply");
    assert.deepEqual(runs.map((run) => run.resume), ["existing-thread", "existing-thread"]);
    assert.match(runs[1].prompt, /Use the mausdroid MCP server/);
    assert.match(runs[1].prompt, /Reading emails, calendars, files and web pages runs directly/);
    assert.match(runs[1].prompt, /Retry the existing email request/);
  } finally {
    await e.stop();
    companion.close();
  }
});

test("MCP checks updated bot permissions on the same bot URL before performing Gmail actions", async () => {
  const { startEngine } = await import("./_engine.mjs");
  const { fakeComposio } = await import("./_composio.mjs");
  const { createHmac } = await import("node:crypto");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tool = "COMPOSIO_MULTI_EXECUTE_TOOL";
  const executed = [];
  const c = await fakeComposio({ mcp: ({ method, params }) => {
    if (method === "initialize") return { protocolVersion: params.protocolVersion, capabilities: { tools: {} } };
    if (method === "tools/list") return { tools: [{ name: tool, description: "Run Gmail tools", inputSchema: { type: "object" } }] };
    if (method === "tools/call") {
      executed.push(params.arguments.tools[0].tool_slug);
      return { content: [{ type: "text", text: "Gmail result" }] };
    }
  } });
  const dir = mkdtempSync(join(tmpdir(), "md-mcp-"));
  const key = "test-mcp-key";
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ "mcp:key": `dev:${Buffer.from(key).toString("base64")}` }));
  const e = await startEngine({ dir, env: { MAUSDROID_COMPOSIO_API: c.url } });
  try {
    assert.equal((await e.call("/api/composio/key", "POST", { key: "ak_test" })).status, 200);
    const bot = (await e.call("/api/state")).data.bots[0];
    const token = createHmac("sha256", key).update(`mcp:${bot.id}`).digest("hex");
    const patch = (body) => e.call(`/api/bots/${bot.id}`, "PATCH", body);
    const call = (tool_slug, signal) => fetch(`${e.base}/mcp/${bot.id}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `composio__${tool}`, arguments: { tools: [{ tool_slug }] } } }),
    }).then((res) => res.json());
    const pendingCard = async () => (await e.call("/api/cards")).data.find((card) => card.botId === bot.id);

    await patch({ approvalMode: "ask-all", cliSession: "existing-thread" });
    const stopped = new AbortController();
    const readWhileRestricted = assert.rejects(call("GMAIL_FETCH_EMAILS", stopped.signal), { name: "AbortError" });
    await e.until(pendingCard, "read approval under ask-all");
    stopped.abort();
    await readWhileRestricted;
    await e.until(async () => !(await pendingCard()), "approval cleared when the MCP client disconnects");
    assert.deepEqual(executed, []);

    const updated = await patch({ approvalMode: "ask-risky" });
    assert.equal(updated.data.cliSession, "existing-thread");
    assert.equal((await call("GMAIL_FETCH_EMAILS")).result.content[0].text, "Gmail result");
    const write = call("GMAIL_SEND_EMAIL");
    const card = await e.until(pendingCard, "DanDroid approval for sending mail");
    assert.deepEqual(executed, ["GMAIL_FETCH_EMAILS"]);
    await e.call(`/api/cards/${card.id}`, "POST", { allow: false });
    assert.equal((await write).result.isError, true);
    assert.deepEqual(executed, ["GMAIL_FETCH_EMAILS"]);
  } finally {
    await e.stop();
    c.close();
  }
});
