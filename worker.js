
const CHANNEL_ID = "@degabet";
const BOT_USERNAME = "DegaBetVotingBot";

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
  if (!data.ok) throw new Error(data.description || "Telegram API error");
  return data.result;
}

function html(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
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

// Create prediction results table automatically.
async function ensurePredictionTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS prediction_results (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      man_united_goals INTEGER NOT NULL,
      brentford_goals INTEGER NOT NULL,
      arsenal_goals INTEGER NOT NULL,
      man_city_goals INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

// ---------------- POLL SYSTEM ----------------

async function createPoll(message, env) {
  const chatId = message.chat.id;
  const input = message.text.replace(/^\/newpoll(?:@\w+)?\s*/i, "");
  const parts = input.split("|").map(x => x.trim()).filter(Boolean);

  if (parts.length < 3) {
    await reply(chatId,
      "የPoll አጠቃቀም፦\n\n" +
      "<code>/newpoll ጥያቄ | ምርጫ 1 | ምርጫ 2</code>", env);
    return;
  }

  const question = parts[0];
  const options = parts.slice(1);

  if (question.length > 250 || options.length > 8 ||
      options.some(x => x.length > 100)) {
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
      text: `📊 <b>${html(question)}</b>\n\n👇 ምርጫዎን ይጫኑ።`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard }
    }, env);

    await env.DB.prepare(
      "UPDATE polls SET message_id = ? WHERE id = ?"
    ).bind(String(posted.message_id), pollId).run();

    await reply(chatId,
      `✅ Poll ተለጥፏል።\nPoll ID: <code>${pollId}</code>\n` +
      `ውጤት: <code>/results ${pollId}</code>\n` +
      `መዝጋት: <code>/close ${pollId}</code>`, env);

  } catch (error) {
    await env.DB.prepare(
      "UPDATE polls SET status = 'failed' WHERE id = ?"
    ).bind(pollId).run();

    await reply(chatId, `❌ ${html(error.message)}`, env);
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
    SELECT po.option_text, v.telegram_user_id,
           v.telegram_username, v.telegram_name
    FROM poll_options po
    LEFT JOIN votes v
      ON v.option_id = po.id AND v.poll_id = po.poll_id
    WHERE po.poll_id = ?
    ORDER BY po.id, v.created_at
  `).bind(pollId).all();

  let output = `📊 <b>${html(poll.question)}</b>\nPoll ID: ${pollId}\n\n`;
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

  await reply(chatId,
    output.length <= 4000 ? output :
    `📊 ${html(poll.question)}\n👥 ጠቅላላ ድምፅ: ${total.total}`,
    env);
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
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");

  try {
    await env.DB.prepare(`
      INSERT INTO votes
        (poll_id, option_id, telegram_user_id, telegram_username, telegram_name)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      pollId, optionId, String(user.id),
      user.username || null, name || "Unknown"
    ).run();

    await callbackAnswer(query.id, "✅ ድምፅዎ ተመዝግቧል።", env);
  } catch (error) {
    const existing = await env.DB.prepare(
      "SELECT id FROM votes WHERE poll_id = ? AND telegram_user_id = ?"
    ).bind(pollId, String(user.id)).first();

    await callbackAnswer(
      query.id,
      existing ? "ድምፅዎን ቀድሞ ሰጥተዋል።" : "ምዝገባው አልተሳካም።",
      env
    );
  }
}

// ---------------- SCORE PREDICTION SYSTEM ----------------

async function createChallenge(chatId, env) {
  const link = `https://t.me/${BOT_USERNAME}?start=predict`;

  const text =
    "⚽ <b>DEGA BET SCORE PREDICTION</b>\n\n" +
    "🏆 <b>የሁለት ጨዋታዎች ውድድር</b>\n\n" +
    "🔴 <b>Match 1</b>\n" +
    "Manchester United 🆚 Brentford\n\n" +
    "🔵 <b>Match 2</b>\n" +
    "Arsenal 🆚 Manchester City\n\n" +
    "🎯 ሁለቱንም ጨዋታዎች በትክክል የገመተ ብቻ አሸናፊ ይሆናል።\n\n" +
    "👇 ግምትዎን ለመስጠት ከታች ይጫኑ።";

  await tg("sendMessage", {
    chat_id: CHANNEL_ID,
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "⚽ ግምት ስጥ", url: link }
      ]]
    }
  }, env);

  await reply(chatId, "✅ የግምት ውድድሩ በChannel ላይ ተለጥፏል።", env);
}

async function savePrediction(message, env) {
  const chatId = message.chat.id;
  const user = message.from;
  const input = (message.text || "").trim();

  const match = input.match(
    /^(\d{1,2})\s*[-:]\s*(\d{1,2})\s*[,/ ]+\s*(\d{1,2})\s*[-:]\s*(\d{1,2})$/
  );

  if (!match) {
    await reply(chatId,
      "❌ የግምት ቅርጹ ትክክል አይደለም።\n\n" +
      "እንዲህ ያስገቡ፦\n<code>2-1, 1-3</code>\n\n" +
      "1ኛ: Man United - Brentford\n" +
      "2ኛ: Arsenal - Man City\n\n" +
      "ለምሳሌ፦ 2-1, 1-3",
      env);
    return;
  }

  const mu = Number(match[1]);
  const br = Number(match[2]);
  const ars = Number(match[3]);
  const mc = Number(match[4]);

  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");

  try {
    await env.DB.prepare(`
      INSERT INTO predictions
      (telegram_user_id, telegram_username, telegram_name,
       man_united_goals, brentford_goals,
       arsenal_goals, man_city_goals)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      String(user.id),
      user.username || null,
      name || "Unknown",
      mu, br, ars, mc
    ).run();

    await reply(chatId,
      "✅ <b>ግምትዎ ተመዝግቧል!</b>\n\n" +
      `Man United ${mu} - ${br} Brentford\n` +
      `Arsenal ${ars} - ${mc} Man City\n\n` +
      "🍀 መልካም ዕድል!",
      env);
  } catch (error) {
    const existing = await env.DB.prepare(
      "SELECT telegram_user_id FROM predictions WHERE telegram_user_id = ?"
    ).bind(String(user.id)).first();

    await reply(chatId,
      existing
        ? "⚠️ ግምትዎን ቀድሞ ሰጥተዋል። ሁለት ጊዜ መመዝገብ አይቻልም።"
        : "❌ ግምትዎን መመዝገብ አልተቻለም።",
      env);
  }
}

async function showPredictions(chatId, env) {
  const rows = await env.DB.prepare(`
    SELECT telegram_name, telegram_username,
           man_united_goals, brentford_goals,
           arsenal_goals, man_city_goals
    FROM predictions
    ORDER BY created_at ASC
  `).all();

  let output = "⚽ <b>DEGA BET — የግምት ዝርዝር</b>\n\n";
  output += `👥 ጠቅላላ ተሳታፊዎች: ${rows.results.length}\n\n`;

  for (let i = 0; i < rows.results.length; i++) {
    const p = rows.results[i];
    output += `${i + 1}. ${html(p.telegram_name || "Unknown")}`;
    if (p.telegram_username) output += ` (@${html(p.telegram_username)})`;
    output += `\nMan United ${p.man_united_goals}-${p.brentford_goals} Brentford`;
    output += `\nArsenal ${p.arsenal_goals}-${p.man_city_goals} Man City\n\n`;

    if (output.length > 3500) {
      await reply(chatId, output, env);
      output = "";
    }
  }

  if (output) await reply(chatId, output, env);
}

async function setPredictionResults(chatId, input, env) {
  const match = input.match(
    /^(\d{1,2})\s*[-:]\s*(\d{1,2})\s*[,/ ]+\s*(\d{1,2})\s*[-:]\s*(\d{1,2})$/
  );

  if (!match) {
    await reply(chatId,
      "ትክክለኛ አጠቃቀም፦\n<code>/setresults 2-1, 1-0</code>",
      env);
    return;
  }

  const scores = match.slice(1).map(Number);

  await env.DB.prepare(`
    INSERT INTO prediction_results
    (id, man_united_goals, brentford_goals,
     arsenal_goals, man_city_goals)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      man_united_goals = excluded.man_united_goals,
      brentford_goals = excluded.brentford_goals,
      arsenal_goals = excluded.arsenal_goals,
      man_city_goals = excluded.man_city_goals,
      created_at = CURRENT_TIMESTAMP
  `).bind(...scores).run();

  const winners = await env.DB.prepare(`
    SELECT telegram_name, telegram_username,
           man_united_goals, brentford_goals,
           arsenal_goals, man_city_goals
    FROM predictions
    WHERE man_united_goals = ?
      AND brentford_goals = ?
      AND arsenal_goals = ?
      AND man_city_goals = ?
  `).bind(...scores).all();

  let output =
    "🏆 <b>DEGA BET — የውድድሩ ውጤት</b>\n\n" +
    `Man United ${scores[0]}-${scores[1]} Brentford\n` +
    `Arsenal ${scores[2]}-${scores[3]} Man City\n\n`;

  if (winners.results.length) {
    output += `🎉 <b>አሸናፊዎች: ${winners.results.length}</b>\n\n`;
    winners.results.forEach((p, i) => {
      output += `${i + 1}. ${html(p.telegram_name || "Unknown")}`;
      if (p.telegram_username) output += ` (@${html(p.telegram_username)})`;
      output += "\n";
    });
  } else {
    output += "እነዚህን ሁለቱንም ውጤቶች በትክክል የገመተ ተሳታፊ የለም።";
  }

  await reply(chatId, output, env);
}

// ---------------- MESSAGE HANDLER ----------------

async function handleMessage(message, env) {
  if (!message.from || message.chat.type !== "private") return;

  const chatId = message.chat.id;
  const text = message.text || "";
  const isAdmin =
    String(message.from.id) === String(env.ADMIN_TELEGRAM_ID);

  // Participants can start and submit predictions.
  if (!isAdmin) {
    if (/^\/start(?:@\w+)?(?:\s+predict)?$/i.test(text)) {
      await reply(chatId,
        "👋 <b>DEGA BET SCORE PREDICTION</b>\n\n" +
        "የሁለቱንም ጨዋታዎች ግምት በአንድ ጊዜ ያስገቡ።\n\n" +
        "ምሳሌ፦ <code>2-1, 1-3</code>\n\n" +
        "1️⃣ Manchester United - Brentford\n" +
        "2️⃣ Arsenal - Manchester City\n\n" +
        "ሁለቱንም በትክክል የገመተ ብቻ አሸናፊ ይሆናል።",
        env);
      return;
    }

    if (/^\d{1,2}\s*[-:]/.test(text)) {
      await savePrediction(message, env);
      return;
    }

    await reply(chatId,
      "የግምት መጀመሪያ ለመጀመር /start ይጫኑ።",
      env);
    return;
  }

  // Admin commands.
  if (/^\/start/i.test(text)) {
    await reply(chatId,
      "👋 <b>DEGA BET Voting Bot — Admin</b>\n\n" +
      "📊 Poll:\n/newpoll ጥያቄ | ምርጫ 1 | ምርጫ 2\n" +
      "/results 1\n/close 1\n\n" +
      "⚽ Prediction:\n" +
      "/newchallenge — ውድድሩን በChannel ላይ ለመለጠፍ\n" +
      "/predictions — የተሳታፊዎችን ግምት ለማየት\n" +
      "/setresults 2-1, 1-0 — ውጤቱን ለማስገባት",
      env);
    return;
  }

  if (/^\/newpoll(?:@\w+)?/i.test(text)) {
    await createPoll(message, env);
    return;
  }

  if (/^\/newchallenge(?:@\w+)?$/i.test(text)) {
    await createChallenge(chatId, env);
    return;
  }

  if (/^\/predictions(?:@\w+)?$/i.test(text)) {
    await showPredictions(chatId, env);
    return;
  }

  const setMatch = text.match(/^\/setresults(?:@\w+)?\s+(.+)$/i);
  if (setMatch) {
    await setPredictionResults(chatId, setMatch[1].trim(), env);
    return;
  }

  const resultsMatch = text.match(/^\/results(?:@\w+)?\s+(\d+)/i);
  if (resultsMatch) {
    await showResults(chatId, Number(resultsMatch[1]), env);
    return;
  }

  const closeMatch = text.match(/^\/close(?:@\w+)?\s+(\d+)/i);
  if (closeMatch) {
    const pollId = Number(closeMatch[1]);
    const result = await env.DB.prepare(
      "UPDATE polls SET status = 'closed' WHERE id = ? AND status = 'active'"
    ).bind(pollId).run();

    await reply(chatId,
      result.meta.changes
        ? `🔒 Poll ${pollId} ተዘግቷል።`
        : "Poll አልተገኘም ወይም ተዘግቷል።",
      env);
    return;
  }

  await reply(chatId, "ትእዛዝ አልተረዳም። /start ብለህ ጀምር።", env);
}

// ---------------- WORKER ----------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("DEGA BET Voting Bot is running.");
    }

    if (request.method === "GET" && url.pathname === "/set-webhook") {
      try {
        const result = await tg("setWebhook", {
          url: `${url.origin}/webhook`,
          secret_token: env.WEBHOOK_SECRET
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
      const receivedSecret = request.headers.get(
        "X-Telegram-Bot-Api-Secret-Token"
      );

      if (!env.WEBHOOK_SECRET ||
          receivedSecret !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const update = await request.json();

        if (update.message) {
          await ensurePredictionTables(env);
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
