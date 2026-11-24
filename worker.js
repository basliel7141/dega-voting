
const CHANNEL_ID = "@degabet";

async function tg(method, body, env) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(data.description || "Telegram API error");
  }

  return data.result;
}

function html(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

async function reply(chatId, text, env) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML"
  }, env);
}

async function callbackAnswer(id, text, env) {
  return tg("answerCallbackQuery", {
    callback_query_id: id,
    text,
    show_alert: true
  }, env);
}

async function createPoll(message, env) {
  const chatId = message.chat.id;

  const input = message.text.replace(
    /^\/newpoll(?:@\w+)?\s*/i,
    ""
  );

  const parts = input.split("|").map(x => x.trim()).filter(Boolean);

  if (parts.length < 3) {
    await reply(
      chatId,
      "የPoll አጠቃቀም፦\n\n" +
      "<code>/newpoll ጥያቄ | ምርጫ 1 | ምርጫ 2</code>",
      env
    );
    return;
  }

  const question = parts[0];
  const options = parts.slice(1);

  if (
    question.length > 250 ||
    options.length > 8 ||
    options.some(x => x.length > 100)
  ) {
    await reply(chatId, "ጥያቄው ወይም ምርጫዎቹ ከተፈቀደው ርዝመት በላይ ናቸው።", env);
    return;
  }

  const inserted = await env.DB.prepare(
    "INSERT INTO polls (question, channel_id, status) VALUES (?, ?, 'active')"
  ).bind(question, CHANNEL_ID).run();

  const pollId = inserted.meta.last_row_id;
  const keyboard = [];

  for (const option of options) {
    const result = await env.DB.prepare(
      "INSERT INTO poll_options (poll_id, option_text) VALUES (?, ?)"
    ).bind(pollId, option).run();

    keyboard.push([{
      text: option,
      callback_data: `v:${pollId}:${result.meta.last_row_id}`
    }]);
  }

  try {
    const posted = await tg("sendMessage", {
      chat_id: CHANNEL_ID,
      text:
        `📊 <b>${html(question)}</b>\n\n` +
        "👇 ምርጫዎን ይጫኑ።\n\n" +
        "🔒 ድምፅዎ በግል ይመዘገባል።",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard }
    }, env);

    await env.DB.prepare(
      "UPDATE polls SET message_id = ? WHERE id = ?"
    ).bind(String(posted.message_id), pollId).run();

    await reply(
      chatId,
      `✅ Poll በChannel ላይ ተለጥፏል።\n` +
      `Poll ID: <code>${pollId}</code>\n\n` +
      `ውጤት: <code>/results ${pollId}</code>\n` +
      `መዝጋት: <code>/close ${pollId}</code>`,
      env
    );

  } catch (error) {
    await env.DB.prepare(
      "UPDATE polls SET status = 'failed' WHERE id = ?"
    ).bind(pollId).run();

    await reply(chatId, `❌ ስህተት፦ ${html(error.message)}`, env);
  }
}

async function showResults(chatId, pollId, env) {
  const poll = await env.DB.prepare(
    "SELECT * FROM polls WHERE id = ?"
  ).bind(pollId).first();

  if (!poll) {
    await reply(chatId, "Poll አልተገኘም።", env);
    return;
  }

  const rows = await env.DB.prepare(`
    SELECT po.option_text,
           v.telegram_user_id,
           v.telegram_username,
           v.telegram_name
    FROM poll_options po
    LEFT JOIN votes v
      ON v.option_id = po.id AND v.poll_id = po.poll_id
    WHERE po.poll_id = ?
    ORDER BY po.id, v.created_at
  `).bind(pollId).all();

  let output = `📊 <b>${html(poll.question)}</b>\n`;
  output += `Poll ID: ${pollId}\n\n`;

  let currentOption = null;
  let count = 0;

  for (const row of rows.results) {
    if (row.option_text !== currentOption) {
      currentOption = row.option_text;
      count = 0;
      output += `\n<b>${html(currentOption)}</b>\n`;
    }

    if (row.telegram_user_id) {
      count++;
      const username = row.telegram_username
        ? ` (@${html(row.telegram_username)})`
        : "";

      output += `${count}. ${html(row.telegram_name || "Unknown")}${username}\n`;
    }
  }

  const total = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM votes WHERE poll_id = ?"
  ).bind(pollId).first();

  output += `\n👥 <b>ጠቅላላ ድምፅ: ${total.total}</b>`;

  await reply(chatId, output, env);
}

async function handleMessage(message, env) {
  if (!message.from || message.chat.type !== "private") return;

  const isAdmin =
    String(message.from.id) === String(env.ADMIN_TELEGRAM_ID);

  if (!isAdmin) {
    await reply(message.chat.id, "⛔ ይህ Bot ለAdmin ብቻ ነው።", env);
    return;
  }

  const text = message.text || "";
  const chatId = message.chat.id;

  if (text.startsWith("/start")) {
    await reply(
      chatId,
      "👋 <b>DEGA BET Voting Bot</b>\n\n" +
      "አዲስ Poll፦\n" +
      "<code>/newpoll ጥያቄ | ምርጫ 1 | ምርጫ 2</code>\n\n" +
      "ውጤት፦ <code>/results 1</code>\n" +
      "መዝጋት፦ <code>/close 1</code>",
      env
    );
    return;
  }

  if (text.startsWith("/newpoll")) {
    await createPoll(message, env);
    return;
  }

  const resultsMatch = text.match(/^\/results(?:@\w+)?\s+(\d+)/);

  if (resultsMatch) {
    await showResults(chatId, Number(resultsMatch[1]), env);
    return;
  }

  const closeMatch = text.match(/^\/close(?:@\w+)?\s+(\d+)/);

  if (closeMatch) {
    const pollId = Number(closeMatch[1]);

    const result = await env.DB.prepare(
      "UPDATE polls SET status = 'closed' WHERE id = ? AND status = 'active'"
    ).bind(pollId).run();

    await reply(
      chatId,
      result.meta.changes
        ? `🔒 Poll ${pollId} ተዘግቷል።`
        : "Poll አልተገኘም ወይም ተዘግቷል።",
      env
    );
    return;
  }

  await reply(chatId, "ትእዛዝ አልተረዳም። /start ብለህ ጀምር።", env);
}

async function handleVote(query, env) {
  const match = (query.data || "").match(/^v:(\d+):(\d+)$/);
  if (!match) return;

  const pollId = Number(match[1]);
  const optionId = Number(match[2]);

  const poll = await env.DB.prepare(
    "SELECT status FROM polls WHERE id = ?"
  ).bind(pollId).first();

  if (!poll || poll.status !== "active") {
    await callbackAnswer(query.id, "ይህ Poll ተዘግቷል።", env);
    return;
  }

  const option = await env.DB.prepare(
    "SELECT id FROM poll_options WHERE id = ? AND poll_id = ?"
  ).bind(optionId, pollId).first();

  if (!option) {
    await callbackAnswer(query.id, "የተሳሳተ ምርጫ ነው።", env);
    return;
  }

  const user = query.from;
  const name = [user.first_name, user.last_name]
    .filter(Boolean).join(" ");

  try {
    await env.DB.prepare(`
      INSERT INTO votes
        (poll_id, option_id, telegram_user_id, telegram_username, telegram_name)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      pollId,
      optionId,
      String(user.id),
      user.username || null,
      name || "Unknown"
    ).run();

    await callbackAnswer(query.id, "✅ ድምፅዎ ተመዝግቧል።", env);

  } catch (error) {
    const existing = await env.DB.prepare(
      "SELECT id FROM votes WHERE poll_id = ? AND telegram_user_id = ?"
    ).bind(pollId, String(user.id)).first();

    if (existing) {
      await callbackAnswer(query.id, "ድምፅዎን ቀድሞ ሰጥተዋል።", env);
    } else {
      await callbackAnswer(query.id, "ድምፅዎን መመዝገብ አልተቻለም።", env);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("DEGA BET Voting Bot is running.");
    }

    if (request.method === "GET" && url.pathname === "/set-webhook") {
      try {
        const result = await tg("setWebhook", {
          url: `${url.origin}/webhook`
        }, env);

        return Response.json({ ok: true, result });
      } catch (error) {
        return Response.json(
          { ok: false, error: error.message },
          { status: 500 }
        );
      }
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const update = await request.json();

        if (update.message) {
          await handleMessage(update.message, env);
        }

        if (update.callback_query) {
          await handleVote(update.callback_query, env);
        }

        return new Response("OK");
      } catch (error) {
        return new Response("Webhook error: " + error.message, {
          status: 500
        });
      }
    }

    return new Response("Not found", { status: 404 });
  }
};
